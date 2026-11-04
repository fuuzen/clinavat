import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { openContained } from '../runtime/contained-files.js';
import { startClaude } from './claude.js';
import { startCodex } from './codex.js';
import { getPermissionMode } from './permissions.js';
import { UserInputRequests } from './user-input.js';
import { RunControl } from './run-control.js';
import { HttpError } from '../models.js';
import type { AgentCallbacks, AgentConfig, AgentContext, AgentRun, ApprovalDecision, InputMode, QueuedInput, RunServices, RunTask,
  TurnOrigin, TurnOutcome } from './types.js';
import type { CodexGoal, CodexGoalChange } from './codex-goal.js';

interface ActiveRun {
  userId: string;
  projectId: string;
  slotId: string;
  context: AgentContext;
  settings: string;
  abort: AbortController;
  startup: Promise<void>;
  control: RunControl;
  finishing?: boolean;
  closing?: boolean;
  run?: AgentRun;
  completion?: Promise<void>;
  credentialError?: Error;
  verifyShell?: () => Promise<void>;
  /** A Hub turn is open: from its message until the CLI's result. */
  turnActive: boolean;
  queue: QueuedInput[];
  idleTimer?: NodeJS.Timeout;
  flushes: Promise<void>;
}

/** What the web UI shows about a resident CLI. */
export interface RuntimeView {
  resident: boolean;
  turnActive: boolean;
  queue: { id: string; content: string; queuedAt: string }[];
  tasks: RunTask[];
}

// Changing any of these needs a new CLI process; everything else can continue in the resident one.
const settingsKey = (context: AgentContext) => JSON.stringify([context.slot.id, context.slot.credential_revision,
  context.session.model ?? null, context.session.reasoning_effort ?? null, context.session.permission_mode ?? null,
  context.session.agent_mode ?? null, context.session.role_preset ?? null]);

/**
 * Keeps one CLI process per conversation across turns. The process holds the slot lease until it has been
 * idle for `runtimeIdleMs`, or until something that needs the slot or project reclaims it.
 */
export class AgentManager {
  private active = new Map<string, ActiveRun>();
  private closing = false;
  readonly questions: UserInputRequests;

  constructor(private config: AgentConfig, private callbacks: AgentCallbacks) {
    this.questions = new UserInputRequests(callbacks.event);
  }

  /** A CLI process exists for the conversation, even if it is only waiting for the next message. */
  isBusy(sessionId: string): boolean { return this.active.has(sessionId); }
  isProjectBusy(projectId: string): boolean { return [...this.active.values()].some(state => state.projectId === projectId); }
  isUserBusy(userId: string): boolean { return [...this.active.values()].some(state => state.userId === userId); }

  view(sessionId: string): RuntimeView {
    const state = this.active.get(sessionId);
    return {
      resident: !!state && !state.finishing && !state.closing,
      turnActive: !!state?.turnActive,
      queue: state?.queue.map(({ id, content, queuedAt }) => ({ id, content, queuedAt })) ?? [],
      tasks: state?.run?.tasks() ?? [],
    };
  }

  /** The resident process can take a new turn with these settings without restarting. */
  accepts(sessionId: string, context: AgentContext): boolean {
    const state = this.active.get(sessionId);
    return !!state?.run && !state.finishing && !state.closing && !state.context.session.command
      && !context.session.command && state.settings === settingsKey(context);
  }

  async start(context: AgentContext, prompt: string): Promise<void> {
    if (this.closing) throw new Error('服务正在关闭');
    if (!prompt.trim() && !(context.session.engine === 'codex' && context.session.goal)) throw new Error('消息不能为空');
    if (context.slot.engine !== context.session.engine) throw new Error('当前账号槽位未启用此引擎');
    if (this.active.has(context.session.id)) throw new Error('当前会话正在运行');
    let startupDone!: () => void;
    const startup = new Promise<void>((resolve) => { startupDone = resolve; });
    // Turn IDs change on this copy as the process moves from turn to turn.
    context = { ...context, session: { ...context.session } };
    const sessionId = context.session.id;
    const state: ActiveRun = { userId: context.user.id, projectId: context.project.id, slotId: context.slot.id, context,
      settings: settingsKey(context), abort: new AbortController(), startup, control: new RunControl(),
      turnActive: true, queue: [], flushes: Promise.resolve() };
    this.active.set(sessionId, state);
    state.control.subscribe(status => {
      if (state.finishing || state.abort.signal.aborted || !state.turnActive || this.active.get(sessionId) !== state) return;
      void this.callbacks.updateSession(sessionId, { status });
      this.callbacks.event({ type: 'turn-state', sessionId, payload: { turnId: context.session.turn_id, status } });
    });
    let expectedShellHash: string;
    let releaseLease: (() => Promise<void>) | undefined;
    let credentialFailure = false;
    const releaseCredentials = async () => {
      const release = releaseLease;
      releaseLease = undefined;
      try { await release?.(); }
      catch (error) {
        credentialFailure = true;
        state.credentialError = error instanceof Error ? error : new Error('槽位运行状态回收失败');
        throw state.credentialError;
      }
    };
    try {
      await this.config.egress?.assertBound(context.slot.id);
      releaseLease = await this.config.credentials.acquire(context);
      if (state.abort.signal.aborted) throw new Error('会话已停止');
      expectedShellHash = await this.shellHash(context);
      state.verifyShell = async () => {
        if (state.abort.signal.aborted) throw new Error('会话已停止');
        if (await this.shellHash(context) !== expectedShellHash) throw new Error('项目执行环境已被修改，请重新打开项目以恢复');
        if (state.abort.signal.aborted) throw new Error('会话已停止');
      };
      const services: RunServices = {
        config: this.config,
        context,
        control: state.control,
        event: (type, payload) => this.callbacks.event({ type, sessionId,
          payload: payload && typeof payload === 'object' ? { ...payload, turnId: context.session.turn_id } : payload }),
        update: async (fields) => { await this.callbacks.updateSession(sessionId, fields); },
        approve: async (tool, input, requestSignal) => {
          const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
          if (signal.aborted) return { decision: 'deny', reason: '审批已取消' };
          await state.control.waitUntilRunning(signal);
          const decision: ApprovalDecision = getPermissionMode(context.session) === 'yolo' && context.session.agent_mode !== 'plan'
            ? { decision: 'allow', reason: 'YOLO：本系统自动批准' }
            : await this.awaitApproval(sessionId, tool, input, signal, state.control);
          await state.control.waitUntilRunning(signal);
          return decision;
        },
        ask: async (questions, requestSignal) => {
          const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
          await state.control.waitUntilRunning(signal);
          const answers = await this.questions.request(sessionId, questions, signal);
          await state.control.waitUntilRunning(signal);
          return answers;
        },
        verifyShell: async () => {
          await state.control.waitUntilRunning(state.abort.signal);
          await state.verifyShell!();
          await state.control.waitUntilRunning(state.abort.signal);
        },
        turnEnded: outcome => this.turnEnded(state, outcome),
        automaticTurn: origin => this.automaticTurn(state, origin),
        activityChanged: () => { this.publish(state); this.scheduleIdle(state); },
      };
      await this.callbacks.updateSession(sessionId, { status: 'running' });
      state.run = context.session.engine === 'claude'
        ? await startClaude(services, prompt, state.abort.signal)
        : await startCodex(services, prompt, state.abort.signal);
      if (state.abort.signal.aborted) state.run.stop();
      this.publish(state);
      // A turn ends through turnEnded; the process ending only settles a turn the CLI left open.
      state.completion = state.run.completion.then(() => undefined, (error: unknown) => error).then(async (failure) => {
        state.finishing = true;
        clearTimeout(state.idleTimer);
        state.control.close();
        try { await releaseCredentials(); } catch (error) { failure = error; }
        await state.flushes;
        const aborted = state.abort.signal.aborted;
        const message = failure instanceof Error ? failure.message : failure ? 'CLI 运行失败' : '';
        if (state.turnActive) {
          state.turnActive = false;
          const status = aborted && !credentialFailure ? 'interrupted' : failure ? 'error' : 'completed';
          if (!aborted) await this.callbacks.flushWorkspace(sessionId).catch(() => undefined);
          await this.callbacks.updateSession(sessionId, { status });
          services.event('turn-state', { status });
          if (failure && (!aborted || credentialFailure)) services.event('error', { message });
          services.event('done', { stopped: aborted, failed: status === 'error' });
        } else if (credentialFailure) {
          await this.callbacks.updateSession(sessionId, { status: 'error' });
          services.event('error', { message });
        }
      }).finally(() => {
        state.abort.abort();
        state.queue = [];
        this.active.delete(sessionId);
        this.publish(state);
      });
      void state.completion.catch(() => undefined);
    } catch (error) {
      const interrupted = state.abort.signal.aborted;
      state.abort.abort();
      state.control.close();
      state.run?.stop();
      await state.run?.completion.catch(() => undefined);
      let failure = error;
      try { await releaseCredentials(); } catch (releaseError) { failure = releaseError; }
      this.active.delete(sessionId);
      const status = interrupted && !credentialFailure ? 'interrupted' : 'error';
      await this.callbacks.updateSession(sessionId, { status });
      this.callbacks.event({ type: 'turn-state', sessionId, payload: { turnId: context.session.turn_id, status } });
      throw failure;
    } finally {
      startupDone();
    }
  }

  /**
   * Sends a message to the resident process. Without an open turn it starts one; otherwise `steer` joins
   * the running turn, `queue` waits for it to end, and `interrupt` ends it and runs next.
   */
  async send(sessionId: string, mode: InputMode, content: string, prompt: string): Promise<'started' | 'steered' | 'queued'> {
    const state = this.residentRun(sessionId);
    const run = state.run!;
    if (!state.turnActive) {
      this.beginTurn(state, this.callbacks.beginTurn(sessionId,
        { messageId: this.callbacks.saveUserMessage(sessionId, content) }, this.authorization(state)), prompt);
      return 'started';
    }
    const input: QueuedInput = { id: randomUUID(), content, prompt, queuedAt: new Date().toISOString() };
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
    const messageId = this.callbacks.saveUserMessage(sessionId, content);
    if (await run.steer(prompt, messageId)) return 'steered';
    // The turn ended while steering; the saved message becomes the next turn.
    if (state.turnActive) {
      state.queue.unshift({ ...input, messageId });
      this.publish(state);
    } else if (!state.finishing && !state.closing) {
      this.beginTurn(state, this.callbacks.beginTurn(sessionId, { messageId }, this.authorization(state)), prompt);
    }
    return 'queued';
  }

  cancelQueued(sessionId: string, inputId: string): void {
    const state = this.active.get(sessionId);
    const index = state?.queue.findIndex(item => item.id === inputId) ?? -1;
    if (!state || index < 0) throw new HttpError(404, '排队消息已发送或不存在');
    state.queue.splice(index, 1);
    this.publish(state);
    this.scheduleIdle(state);
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const state = this.residentRun(sessionId);
    if (!state.run!.tasks().some(task => task.id === taskId)) throw new HttpError(404, '后台任务已结束或不存在');
    await state.run!.stopTask(taskId);
  }

  /** Ends the resident process if it has nothing left to do; a busy one stays and keeps its lease. */
  async reclaim(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state?.run || state.turnActive || state.queue.length || !state.run.isIdle()) return;
    this.closeRuntime(state);
    await state.completion?.catch(() => undefined);
  }

  async reclaimWhere(filter: { projectId?: string; slotId?: string; userId?: string }): Promise<void> {
    await Promise.all([...this.active.entries()].filter(([, state]) =>
      (!filter.projectId || state.projectId === filter.projectId) && (!filter.slotId || state.slotId === filter.slotId)
      && (!filter.userId || state.userId === filter.userId)).map(([sessionId]) => this.reclaim(sessionId)));
  }

  private residentRun(sessionId: string): ActiveRun {
    const state = this.active.get(sessionId);
    if (!state || state.finishing || state.closing || state.abort.signal.aborted) throw new HttpError(409, '当前执行已结束，请重新发送');
    if (!state.run) throw new HttpError(409, 'CLI 正在启动，请稍后重试');
    return state;
  }

  private authorization(state: ActiveRun) {
    return { slotId: state.context.slot.id, credentialRevision: state.context.slot.credential_revision };
  }

  private beginTurn(state: ActiveRun, turnId: string, prompt: string): void {
    clearTimeout(state.idleTimer);
    state.turnActive = true;
    state.context.session.turn_id = turnId;
    void this.callbacks.updateSession(state.context.session.id, { status: 'running' });
    this.publish(state);
    void state.run!.startTurn(prompt).catch((error: unknown) => {
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
    // Everything below is synchronous: the CLI may already be emitting the next turn's events.
    if (outcome.output) void this.callbacks.saveMessage(sessionId, 'assistant', outcome.output);
    void this.callbacks.updateSession(sessionId, { status: outcome.status });
    this.callbacks.event({ type: 'turn-state', sessionId, payload: { turnId, status: outcome.status } });
    if (outcome.status === 'error') {
      this.callbacks.event({ type: 'error', sessionId, payload: { turnId, message: outcome.error || 'CLI 运行失败' } });
    }
    this.callbacks.event({ type: 'done', sessionId, payload: { turnId, stopped: outcome.status === 'interrupted', failed: outcome.status === 'error' } });
    state.flushes = state.flushes.then(() => this.callbacks.flushWorkspace(sessionId)).catch((error: unknown) => {
      this.callbacks.event({ type: 'error', sessionId, payload: { message: error instanceof Error ? error.message : '工作区同步失败' } });
    });
    // A one-off command such as /compact does not leave a process for ordinary turns.
    if (state.context.session.command) { this.closeRuntime(state); return; }
    const next = state.queue.shift();
    if (next && !state.closing) {
      try {
        const messageId = next.messageId ?? this.callbacks.saveUserMessage(sessionId, next.content);
        this.beginTurn(state, this.callbacks.beginTurn(sessionId, { messageId }, this.authorization(state)), next.prompt);
      } catch (error) {
        this.callbacks.event({ type: 'error', sessionId, payload: { message: error instanceof Error ? error.message : '排队消息发送失败' } });
        this.publish(state);
        this.scheduleIdle(state);
      }
      return;
    }
    this.publish(state);
    this.scheduleIdle(state);
  }

  private automaticTurn(state: ActiveRun, origin: TurnOrigin): void {
    if (state.turnActive || state.finishing) return;
    const sessionId = state.context.session.id;
    try {
      const turnId = this.callbacks.beginTurn(sessionId, origin, this.authorization(state));
      clearTimeout(state.idleTimer);
      state.turnActive = true;
      state.context.session.turn_id = turnId;
      void this.callbacks.updateSession(sessionId, { status: 'running' });
      this.publish(state);
    } catch (error) {
      this.callbacks.event({ type: 'error', sessionId, payload: { message: error instanceof Error ? error.message : '无法记录自动续轮' } });
    }
  }

  private scheduleIdle(state: ActiveRun): void {
    clearTimeout(state.idleTimer);
    if (state.finishing || state.closing || state.turnActive || state.queue.length || !state.run?.isIdle()) return;
    state.idleTimer = setTimeout(() => this.closeRuntime(state), this.config.runtimeIdleMs);
    state.idleTimer.unref();
  }

  private closeRuntime(state: ActiveRun): void {
    if (state.closing || state.finishing) return;
    state.closing = true;
    clearTimeout(state.idleTimer);
    this.publish(state);
    state.run?.close();
  }

  private publish(state: ActiveRun): void {
    const sessionId = state.context.session.id;
    const view = this.active.get(sessionId) === state ? this.view(sessionId)
      : { resident: false, turnActive: false, queue: [], tasks: [] };
    this.callbacks.event({ type: 'runtime', sessionId, payload: view });
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state) return;
    state.abort.abort();
    state.queue = [];
    state.control.close();
    state.run?.stop();
    await state.startup;
    await state.completion;
    if (state.credentialError) throw state.credentialError;
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
    const state = this.active.get(sessionId);
    if (!state || state.finishing || state.abort.signal.aborted) throw new HttpError(409, '当前执行已结束，无法原位继续');
    if (!state.run) throw new HttpError(409, 'CLI 正在启动，请稍后重试');
    return state;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active.keys()].map(sessionId => this.stop(sessionId)));
  }

  private async shellHash(context: AgentContext): Promise<string> {
    if (context.project.execution_mode === 'local') {
      const directory = await realpath(context.project.local_path);
      if (directory !== context.project.local_path || !(await stat(directory)).isDirectory()) {
        throw new Error('本机项目目录已发生变化，请重新打开项目');
      }
      return directory;
    }
    try {
      const { handle } = await openContained(context.project.local_path, '.bin/remote-shell');
      try { return createHash('sha256').update(await handle.readFile()).digest('hex'); }
      finally { await handle.close(); }
    } catch { throw new Error('项目远程执行器尚未准备好，请先重新同步项目'); }
  }

  private awaitApproval(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal, control: RunControl): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny', reason: '会话已停止' });
    const request = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        signal.removeEventListener('abort', abort);
        request.abort();
        resolve(decision);
      };
      const abort = () => finish({ decision: 'deny', reason: '会话已停止' });
      const cancelTimeout = control.timer(() => finish({ decision: 'deny', reason: '审批超时，已自动拒绝' }), this.config.approvalTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      void this.callbacks.approval({ sessionId, tool, input, signal: request.signal,
        scheduleTimeout: (callback, milliseconds) => control.timer(callback, milliseconds) }).then(finish)
        .catch(() => finish({ decision: 'deny', reason: '审批服务不可用，已拒绝' }));
    });
  }
}
