import { randomUUID } from 'node:crypto';
import { startClaude } from './claude/run.js';
import { startCodex } from './codex/run.js';
import { startAntigravity } from './antigravity/run.js';
import { engineProfiles, type AgentEngine } from './engines.js';
import { UserInputRequests } from './user-input.js';
import { HttpError } from '../models.js';
import {
  attachRunCompletion, createActiveRun, createCredentialLeaseTracker, handleStartupFailure, prepareRunServices,
} from './run-context.js';
import { RuntimeFailovers } from './runtime-failover.js';
import { readResidentUsage } from './resident-usage.js';
import type { UsageSlot } from '../accounts/usage.js';
import {
  acceptsResidentContext, buildAgentErrorPayload, hasResidentBackgroundWork, isIdleResidentRun, runtimeViewOf,
  summarizeActiveRuns, type ActiveRun, type RunContinuation, type RuntimeView,
} from './resident-run.js';
export type { RuntimeView } from './resident-run.js';
import type {
  AgentCallbacks, AgentConfig, AgentContext, AgentPrompt, AgentRun, InputMode, MessageSource, QueuedInput,
  RunServices, TurnOrigin, TurnOutcome,
} from './types.js';
import type { CodexGoal, CodexGoalChange } from './codex/goal.js';

const starters: Record<AgentEngine, (services: RunServices, prompt: AgentPrompt, signal: AbortSignal) => Promise<AgentRun>> = {
  claude: startClaude, codex: startCodex, antigravity: startAntigravity,
};

/**
 * Keeps one CLI process per conversation across turns. The process holds the slot lease until it has been
 * idle for `runtimeIdleMs`, or until something that needs the slot or project reclaims it.
 */
export class AgentManager {
  private active = new Map<string, ActiveRun>();
  private closing = false;
  private failovers: RuntimeFailovers;
  readonly questions: UserInputRequests;

  constructor(private config: AgentConfig, private callbacks: AgentCallbacks) {
    this.questions = new UserInputRequests(callbacks.event);
    this.failovers = new RuntimeFailovers(callbacks, {
      current: sessionId => this.active.get(sessionId),
      start: (context, prompt, continuation) => this.start(context, prompt, continuation),
      close: state => this.closeRuntime(state), publish: state => this.publish(state),
      usage: config.usage,
    });
  }

  /** A CLI process exists for the conversation, even if it is only waiting for the next message. */
  isBusy(sessionId: string): boolean { return this.active.has(sessionId) || this.failovers.has(sessionId); }
  readUsage(slot: UsageSlot) { return readResidentUsage(this.active, this.config, slot); }
  isProjectBusy(projectId: string): boolean { return this.failovers.matches({ projectId }) || [...this.active.values()].some(state => state.projectId === projectId); }
  isUserBusy(userId: string): boolean { return this.failovers.matches({ userId }) || [...this.active.values()].some(state => state.userId === userId); }
  activitySummary(): { activeSessions: number; idleResidentSessions: number } { return summarizeActiveRuns(this.active, sessionId => this.failovers.has(sessionId)); }
  hasBackgroundWork(sessionId: string): boolean { return hasResidentBackgroundWork(this.active.get(sessionId)); }
  accepts(sessionId: string, context: AgentContext): boolean { return acceptsResidentContext(this.active.get(sessionId), context, this.failovers.has(sessionId)); }

  view(sessionId: string): RuntimeView {
    const state = this.active.get(sessionId);
    const switching = this.failovers.view(sessionId);
    if (switching && (this.failovers.has(sessionId) || !state)) return switching;
    return runtimeViewOf(state);
  }

  /** `images` are the IDs of the images attached to the first message. */
  async start(context: AgentContext, prompt: string, continuation?: RunContinuation, images: string[] = []): Promise<void> {
    if (this.closing) throw new DOMException('服务正在关闭', 'AbortError');
    if (!prompt.trim() && !images.length && !(engineProfiles[context.session.engine].goal && context.session.goal)) throw new Error('消息不能为空');
    if (context.slot.engine !== context.session.engine) throw new Error('当前账号槽位未启用此引擎');
    if (this.active.has(context.session.id)) throw new Error('当前会话正在运行');
    const input = { text: prompt, images: this.callbacks.loadImages(context.session.id, images) };
    // Turn IDs change on this copy as the process moves from turn to turn.
    context = { ...context, project: { ...context.project }, session: { ...context.session } };
    const sessionId = context.session.id;
    if (!context.session.native_session_id || context.session.command === 'compact') this.config.orchestration?.clearInspectCache(sessionId);
    const queue = continuation?.queue ?? this.failovers.takeQueue(sessionId);
    const { state, startupDone } = createActiveRun(context, queue, continuation, this.callbacks, run => this.active.get(sessionId) === run);
    this.active.set(sessionId, state);
    const lease = createCredentialLeaseTracker(state);
    const teardownHooks = {
      callbacks: this.callbacks, lease, isClosing: () => this.closing,
      retainQueue: (id: string, items: QueuedInput[]) => this.failovers.retainQueue(id, items),
      clearActive: (id: string, run: ActiveRun) => { if (this.active.get(id) === run) this.active.delete(id); },
      emitError: (run: ActiveRun, message: string) => this.emitError(run, message),
      publish: (run: ActiveRun) => this.publish(run),
    };
    try {
      const services = await prepareRunServices({
        config: this.config, callbacks: this.callbacks, questions: this.questions, state,
        turnEnded: outcome => this.turnEnded(state, outcome),
        automaticTurn: origin => this.automaticTurn(state, origin),
        activityChanged: () => { this.publish(state); this.scheduleIdle(state); },
      }, lease);
      await this.callbacks.updateSession(sessionId, { status: 'running' });
      state.cliStarting = true;
      state.run = await starters[context.session.engine](services, input, state.abort.signal);
      if (state.abort.signal.aborted) state.run.stop();
      this.publish(state);
      state.completion = attachRunCompletion(state, services, teardownHooks);
    } catch (error) {
      await handleStartupFailure(state, error, teardownHooks);
    } finally {
      startupDone();
    }
  }

  /**
   * Sends a message to the resident process. Without an open turn it starts one; otherwise `steer` joins
   * the running turn, `queue` waits for it to end, and `interrupt` ends it and runs next.
   */
  async send(sessionId: string, mode: InputMode, content: string, prompt: string, images: string[] = [],
    source?: MessageSource, messageId: string = randomUUID()): Promise<'started' | 'steered' | 'queued'> {
    const state = this.residentRun(sessionId);
    const run = state.run!;
    if (!state.turnActive) {
      this.beginTurn(state, this.callbacks.beginTurn(sessionId,
        { messageId: this.callbacks.saveUserMessage(sessionId, content, images, source, messageId) }, this.authorization(state)), prompt, images);
      return 'started';
    }
    const input: QueuedInput = { id: messageId, content, prompt, queuedAt: new Date().toISOString(),
      ...(images.length ? { images } : {}), ...(source ? { source } : {}) };
    if (mode === 'queue') {
      if (state.queue.length >= 20) throw new HttpError(409, '排队消息已达上限，请等待当前回复结束');
      state.queue.push(input);
      this.publish(state);
      return 'queued';
    }
    if (state.control.state !== 'running') throw new HttpError(409, '任务已暂停，请先继续，或改为排队发送');
    if (mode === 'interrupt') {
      state.queue.unshift(input);
      this.publish(state);
      await run.interruptTurn();
      return 'queued';
    }
    const promptImages = this.callbacks.loadImages(sessionId, images);
    this.callbacks.saveUserMessage(sessionId, content, images, source, messageId);
    if (await run.steer({ text: prompt, images: promptImages }, messageId)) return 'steered';
    // The turn ended while steering; the saved message becomes the next turn.
    if (state.turnActive) {
      state.queue.unshift({ ...input, messageId });
      this.publish(state);
    } else if (!state.finishing && !state.closing) {
      this.beginTurn(state, this.callbacks.beginTurn(sessionId, { messageId }, this.authorization(state)), prompt, images);
    }
    return 'queued';
  }

  cancelQueued(sessionId: string, inputId: string): void {
    const state = this.active.get(sessionId);
    const queue = this.failovers.queue(sessionId) ?? state?.queue;
    const index = queue?.findIndex(item => item.id === inputId) ?? -1;
    if (!queue || index < 0) throw new HttpError(404, '排队消息已发送或不存在');
    queue.splice(index, 1);
    if (state) { this.publish(state); this.scheduleIdle(state); }
    else this.publishRuntime(sessionId);
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state?.run || !state.run.tasks().some(task => task.id === taskId)) throw new HttpError(404, '后台任务已结束或不存在');
    await state.run!.stopTask(taskId);
  }

  /** Ends the resident process if it has nothing left to do; a busy one stays and keeps its lease. */
  async reclaim(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state || !isIdleResidentRun(state, this.failovers.has(sessionId))) return;
    this.closeRuntime(state);
    await state.completion?.catch(() => undefined);
    this.config.orchestration?.clearInspectCache(sessionId);
  }

  /** Closes every idle resident CLI without interrupting running turns, queues, or background tasks. */
  reclaimIdle(): number {
    let reclaimed = 0;
    for (const [sessionId, state] of this.active) {
      if (!isIdleResidentRun(state, this.failovers.has(sessionId))) continue;
      this.closeRuntime(state);
      void state.completion?.catch(() => undefined).finally(() => this.config.orchestration?.clearInspectCache(sessionId));
      reclaimed++;
    }
    return reclaimed;
  }

  async reclaimWhere(filter: { projectId?: string; slotId?: string; userId?: string }): Promise<void> {
    await Promise.all([...this.active.entries()].filter(([, state]) =>
      (!filter.projectId || state.projectId === filter.projectId) && (!filter.slotId || state.slotId === filter.slotId)
      && (!filter.userId || state.userId === filter.userId)).map(([sessionId]) => this.reclaim(sessionId)));
  }

  private residentRun(sessionId: string): ActiveRun {
    const state = this.active.get(sessionId);
    if (this.failovers.has(sessionId)) throw new HttpError(409, '正在切换账号，请稍后发送；仍可停止当前任务');
    if (!state || state.finishing || state.closing || state.abort.signal.aborted) throw new HttpError(409, '当前执行已结束，请重新发送');
    if (!state.run) throw new HttpError(409, 'CLI 正在启动，请稍后重试');
    return state;
  }

  private authorization(state: ActiveRun) { return { slotId: state.context.slot.id, credentialRevision: state.context.slot.credential_revision }; }

  private beginTurn(state: ActiveRun, turnId: string, prompt: string, images: string[]): void {
    clearTimeout(state.idleTimer);
    state.turnActive = true;
    state.attemptedSlotIds = [];
    state.context.session.turn_id = turnId;
    void this.callbacks.updateSession(state.context.session.id, { status: 'running' });
    this.publish(state);
    const start = async () => state.run!.startTurn({ text: prompt, images: this.callbacks.loadImages(state.context.session.id, images) });
    void start().catch((error: unknown) => {
      if (state.context.session.turn_id === turnId) {
        this.turnEnded(state, { status: 'error', error: error instanceof Error ? error.message : 'CLI 无法开始新一轮' });
      }
    });
  }

  private turnEnded(state: ActiveRun, outcome: TurnOutcome): void {
    if (!state.turnActive || state.finishing) return;
    const sessionId = state.context.session.id;
    const turnId = state.context.session.turn_id;
    state.turnActive = false;
    if (!outcome.quota) this.failovers.supersede(state);
    const switching = outcome.status === 'error' && !!outcome.quota && this.failovers.begin(state, outcome.quota);
    if (outcome.status === 'error' && state.context.session.slot_mode === 'auto' && !switching
      && !state.abort.signal.aborted && !this.closing) {
      state.halted = true;
      this.failovers.halt(state);
    }
    if (outcome.status === 'completed') state.attemptedSlotIds = [];
    // Everything below is synchronous: the CLI may already be emitting the next turn's events.
    if (outcome.output) void this.callbacks.saveMessage(sessionId, 'assistant', outcome.output);
    void this.callbacks.updateSession(sessionId, { status: switching ? 'running' : state.halted ? 'error' : outcome.status });
    if (outcome.status === 'error' && !switching) this.emitError(state, outcome.error || 'CLI 运行失败', outcome.quota);
    this.callbacks.event({ type: 'turn-state', sessionId, payload: { turnId, status: outcome.status } });
    if (!switching) this.callbacks.event({ type: 'done', sessionId,
      payload: { turnId, stopped: outcome.status === 'interrupted', failed: outcome.status === 'error' } });
    state.flushes = state.flushes.then(() => this.callbacks.flushWorkspace(sessionId)).catch((error: unknown) => {
      state.flushError = error instanceof Error ? error : new Error('工作区同步失败');
      this.callbacks.event({ type: 'error', sessionId, payload: { message: error instanceof Error ? error.message : '工作区同步失败' } });
    });
    if (switching || state.halted) { this.publish(state); return; }
    if (state.context.session.command) { this.closeRuntime(state); return; }
    const next = !state.closing && !state.abort.signal.aborted && !this.closing ? state.queue.shift() : undefined;
    if (next && !state.closing) {
      try {
        next.messageId ??= this.callbacks.saveUserMessage(sessionId, next.content, next.images ?? [], next.source, next.id);
        this.beginTurn(state, this.callbacks.beginTurn(sessionId, { messageId: next.messageId }, this.authorization(state)),
          next.prompt, next.images ?? []);
      } catch (error) {
        state.queue.unshift(next);
        this.callbacks.event({ type: 'error', sessionId, payload: { message: error instanceof Error ? error.message : '排队消息发送失败' } });
        this.publish(state); this.scheduleIdle(state);
      }
      return;
    }
    this.publish(state);
    this.scheduleIdle(state);
  }

  private automaticTurn(state: ActiveRun, origin: TurnOrigin): void {
    if (state.turnActive || state.finishing || state.abort.signal.aborted || this.closing) return;
    const sessionId = state.context.session.id;
    try {
      const turnId = this.callbacks.beginTurn(sessionId, origin, this.authorization(state));
      clearTimeout(state.idleTimer);
      state.turnActive = true;
      state.context.session.turn_id = turnId;
      void this.callbacks.updateSession(sessionId, { status: state.halted ? 'error' : 'running' });
      this.publish(state);
    } catch (error) {
      this.callbacks.event({ type: 'error', sessionId, payload: { message: error instanceof Error ? error.message : '无法记录自动续轮' } });
    }
  }

  private scheduleIdle(state: ActiveRun): void {
    clearTimeout(state.idleTimer);
    if (!isIdleResidentRun(state, this.failovers.has(state.context.session.id))) return;
    const delayMs = this.callbacks.isMaintenanceMode?.() ? 0 : this.config.runtimeIdleMs;
    state.idleTimer = setTimeout(() => {
      if (isIdleResidentRun(state, this.failovers.has(state.context.session.id))) this.closeRuntime(state);
    }, delayMs);
    state.idleTimer.unref();
  }

  private closeRuntime(state: ActiveRun): void {
    if (state.closing || state.finishing) return;
    state.closing = true;
    clearTimeout(state.idleTimer);
    this.publish(state);
    state.run?.close();
  }

  private publish(state: ActiveRun): void { this.publishRuntime(state.context.session.id); }

  private publishRuntime(sessionId: string): void {
    const queue = this.failovers.has(sessionId) ? this.failovers.queue(sessionId)
      : this.active.get(sessionId)?.queue ?? this.failovers.queue(sessionId);
    this.callbacks.saveQueuedInputs?.(sessionId, queue ?? []);
    this.callbacks.event({ type: 'runtime', sessionId, payload: this.view(sessionId) });
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (this.closing && state) this.failovers.retainQueue(sessionId, state.queue);
    if (!this.closing) this.callbacks.saveQueuedInputs?.(sessionId, []);
    const switching = this.failovers.stop(sessionId, this.closing);
    if (state) {
      state.abort.abort();
      if (!this.closing) state.queue = [];
      state.control.close(); state.run?.stop();
      await state.startup;
      await state.completion;
    }
    await switching;
    this.publishRuntime(sessionId);
    if (state?.credentialError) throw state.credentialError;
  }

  pause(sessionId: string): string {
    const state = this.controllableRun(sessionId);
    if (!state.turnActive) throw new HttpError(409, '当前没有正在执行的回复');
    void state.control.pause().catch(error => {
      if (!state.abort.signal.aborted && !state.finishing) this.callbacks.event({ type: 'error', sessionId,
        payload: { message: `暂停失败：${error instanceof Error ? error.message : '无法挂起执行进程'}` } });
    });
    return state.control.state;
  }

  async resume(sessionId: string): Promise<string> {
    const state = this.controllableRun(sessionId);
    await state.verifyShell?.();
    await state.control.resume();
    return state.control.state;
  }

  async getGoal(sessionId: string): Promise<CodexGoal | null> {
    const state = this.controllableRun(sessionId);
    if (!state.run?.goal) throw new HttpError(409, '当前执行尚未准备好 Goal 控制');
    return state.run.goal.get();
  }

  async changeGoal(sessionId: string, change: CodexGoalChange): Promise<CodexGoal | null> {
    const state = this.controllableRun(sessionId);
    if (!state.run?.goal) throw new HttpError(409, '当前执行尚未准备好 Goal 控制');
    if (change.action === 'resume') {
      if (state.control.state !== 'running') throw new HttpError(409, '请先继续当前任务，再恢复目标');
      await state.verifyShell?.();
    }
    return state.run.goal.set(change);
  }

  private controllableRun(sessionId: string): ActiveRun {
    if (this.failovers.has(sessionId)) throw new HttpError(409, '正在切换账号，暂不能暂停或继续；仍可停止任务');
    const state = this.active.get(sessionId);
    if (!state || state.finishing || state.abort.signal.aborted) throw new HttpError(409, '当前执行已结束，无法原位继续');
    if (!state.run) throw new HttpError(409, 'CLI 正在启动，请稍后重试');
    return state;
  }

  private emitError(state: ActiveRun, message: string, quota?: TurnOutcome['quota']): void {
    this.callbacks.event({ type: 'error', sessionId: state.context.session.id, payload: buildAgentErrorPayload(message, state.context,
      { turnId: state.context.session.turn_id, quota, attemptedSlotIds: state.attemptedSlotIds, usage: this.config.usage }) });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active.keys()].map(sessionId => this.stop(sessionId)));
    await this.failovers.close();
  }
}
