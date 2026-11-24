import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '../context.js';
import type { Session, User } from '../models.js';
import { orchestrationModeOf } from '../agent/orchestration-tools.js';
import type { RuntimeView } from '../agent/manager.js';
import type { AgentEvent } from '../agent/types.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { rolloverSession } from '../routes/sessions.js';
import { reportBlock, type ReportSource } from './instructions.js';
import { orchestrationConstants } from './limits.js';
import type { AgentTask, AgentTasks } from './tasks.js';

const finishedStatuses = new Set(['completed', 'interrupted', 'error']);
const fallbackReports: Record<string, string> = {
  completed: '子智能体没有给出最终回复。',
  interrupted: '子智能体的执行被中断，没有给出最终回复。',
  error: '子智能体出错，没有给出最终回复。',
};

/** A child whose turn ended while its CLI still ran work of its own; `idle` says whether that work has ended since. */
interface DeferredReport { turnId?: string; idle: boolean; timer: NodeJS.Timeout }

const messageLimit = 90_000;

function needsRollover(session: Session): boolean {
  const limit = orchestrationConstants.superAutoRolloverTokens;
  const threshold = session.last_context_window > 0 ? Math.min(limit, Math.floor(session.last_context_window * 0.7)) : limit;
  return orchestrationModeOf(session) === 'super' && !!session.native_session_id
    && session.last_context_tokens > 0 && session.last_context_tokens >= threshold;
}

/** Keep each released wave in one message, sharing space among its reports when the full blocks would overflow. */
function formatBatch(sources: ReportSource[], superAgent: boolean): { count: number; content: string; prompt: string } {
  const render = (stored: boolean, textLimit?: number) => sources.map(source => reportBlock(source, { superAgent, stored, textLimit })).join('\n\n');
  let textLimit: number | undefined;
  let content = render(true);
  if (content.length > messageLimit) {
    const overhead = sources.reduce((sum, source) => sum + reportBlock({ ...source, text: '' }, { superAgent }).length + 2, 0);
    // Reserve room for the head/tail omission notice and the archived-report reference in each block.
    textLimit = Math.max(0, Math.floor((messageLimit - overhead) / sources.length) - 256);
    content = render(true, textLimit);
    if (content.length > messageLimit) {
      // Even the individual report envelopes need more than one message.
      return formatBatch(sources.slice(0, Math.ceil(sources.length / 2)), superAgent);
    }
  }
  return { count: sources.length, content, prompt: superAgent ? render(false, textLimit) : content };
}

/**
 * Ends a child's tasks when it goes idle, and hands their reports to the master: as one new message after a short
 * delay, or to a wait_agents call that is waiting for them.
 */
export class ReportDelivery {
  private errors = new Map<string, string>();
  private waiters = new Map<string, Set<() => void>>();
  private awaited = new Map<string, number>();
  /** Tasks that finished while this process ran; earlier ones wait for the user to deliver them. */
  private deliverable = new Set<string>();
  private timers = new Map<string, Promise<void>>();
  private rollovers = new Map<string, Promise<Session | null>>();
  private paused = new Set<string>();
  private quotaAnchor = new Map<string, string>();
  private deferred = new Map<string, DeferredReport>();

  constructor(
    private readonly context: Context,
    private readonly tasks: AgentTasks,
    private readonly changed: (masterId: string) => void,
    private readonly deliveredTasks?: (user: User, master: Session, tasks: AgentTask[]) => void,
  ) {}

  observe(event: AgentEvent): void {
    const payload = event.payload as { status?: string; message?: string; turnId?: string } | undefined;
    if (event.type === 'error' && payload?.message) this.errors.set(event.sessionId, payload.message);
    if (event.type === 'runtime') { this.runtimeChanged(event.sessionId, event.payload as RuntimeView); return; }
    if (event.type !== 'turn-state' || !finishedStatuses.has(payload?.status ?? '')) return;
    const session = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=?', event.sessionId);
    if (!session) return;
    if (payload?.status === 'completed' && needsRollover(session)) {
      void this.schedule(session.id).then(() => this.maybeAutoRollover(session)).catch((error: unknown) => {
        this.context.events.emit(session.user_id, { type: 'notice', sessionId: session.id,
          payload: { message: `自动续接上下文失败：${error instanceof Error ? error.message : String(error)}` } });
      });
    } else if (session.orchestration) this.schedule(session.id);
    if (session.parent_session_id) this.childTurnEnded(session, payload!.status as 'completed' | 'interrupted' | 'error', payload!.turnId);
  }

  private childTurnEnded(child: Session, status: 'completed' | 'interrupted' | 'error', turnId?: string): void {
    this.clearDeferred(child.id);
    // Called before the manager starts the next queued message, so a queue still holds what comes next.
    const runtime = this.context.agents.view(child.id);
    if (runtime.switching || runtime.queue.length) return;
    if (!this.tasks.running(child.id).length) return;
    // The CLI resumes by itself when its own work ends: Claude after a background agent, agy after a command it moved
    // to the background. Reporting now would hand the master a reply that only says it is waiting.
    if (status === 'completed' && (runtime.tasks.length || this.context.agents.hasBackgroundWork(child.id))) {
      this.defer(child.id, turnId);
      return;
    }
    this.finishChild(child, status, turnId);
  }

  private finishChild(child: Session, status: 'completed' | 'interrupted' | 'error', turnId?: string, note = ''): void {
    const answer = turnId ? this.context.store.get<{ content: string }>(`SELECT messages.content FROM session_turns
      JOIN messages ON messages.id=session_turns.assistant_message_id WHERE session_turns.id=?`, turnId)?.content : undefined;
    const error = this.errors.get(child.id);
    this.errors.delete(child.id);
    const suffix = (status === 'error' ? `\n\n[子智能体出错：${error ?? '未知错误'}]` : '') + note;
    void this.complete(child, status, (answer?.trim() || fallbackReports[status]) + (answer ? suffix : suffix.trimStart()));
  }

  private defer(childId: string, turnId?: string): void {
    const timer = setTimeout(() => this.settleDeferred(childId, 'timeout'), orchestrationConstants.backgroundReportWaitMs);
    timer.unref();
    this.deferred.set(childId, { turnId, idle: false, timer });
  }

  private clearDeferred(childId: string): void {
    clearTimeout(this.deferred.get(childId)?.timer);
    this.deferred.delete(childId);
  }

  /** A waiting child's report follows its process out: the next turn would never come. */
  private runtimeChanged(childId: string, runtime: RuntimeView): void {
    const entry = this.deferred.get(childId);
    if (!entry) return;
    if (runtime.resident) {
      entry.idle = !runtime.turnActive && !runtime.tasks.length && !this.context.agents.hasBackgroundWork(childId);
      return;
    }
    // A stop delivers its own report right after the process ends; this one only covers an exit nobody asked for.
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.settleDeferred(childId, 'exited'), orchestrationConstants.deliveryDelayMs);
    entry.timer.unref();
  }

  private settleDeferred(childId: string, reason: 'exited' | 'timeout'): void {
    const entry = this.deferred.get(childId);
    this.clearDeferred(childId);
    // A turn under way reports when it ends.
    if (!entry || this.context.agents.view(childId).turnActive) return;
    const child = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=?', childId);
    if (!child) return;
    if (entry.idle) this.finishChild(child, 'completed', entry.turnId);
    else if (reason === 'timeout') this.finishChild(child, 'completed', entry.turnId, '\n\n[子智能体的后台工作仍在运行，以上是它最近一轮的回复]');
    else this.finishChild(child, 'interrupted', entry.turnId, '\n\n[子智能体的进程在后台工作结束前退出]');
  }

  /** Ends the child's tasks; a child in its own worktree first gets its work committed, and the report says where it is. */
  async complete(child: Session, status: 'completed' | 'interrupted' | 'error', report: string): Promise<void> {
    this.clearDeferred(child.id);
    const ending = this.tasks.running(child.id).map(task => task.id);
    if (!ending.length) return;
    const worktree = child.agent_isolation === 'worktree' && this.context.worktrees
      ? await this.context.worktrees.settle(child).catch((error: unknown) => `[worktree] 无法检查子智能体的修改：${error instanceof Error ? error.message : String(error)}`)
      : '';
    const finished = this.tasks.finish(child.id, status, worktree ? `${report}\n\n${worktree}` : report, ending);
    if (!finished.length || !child.parent_session_id) return;
    for (const task of finished) if (task.notify) this.deliverable.add(task.id);
    for (const wake of this.waiters.get(child.id) ?? []) wake();
    this.changed(child.parent_session_id);
    this.schedule(child.parent_session_id);
  }

  /** Waits until none of the children has a task in progress; reports reaching a waiter skip the master's queue. */
  async wait(childIds: string[], timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    for (const id of childIds) this.awaited.set(id, (this.awaited.get(id) ?? 0) + 1);
    try {
      const deadline = Date.now() + timeoutMs;
      while (childIds.some(id => this.tasks.running(id).length)) {
        if (signal.aborted || Date.now() >= deadline) return false;
        await new Promise<void>(resolve => {
          const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
          function wake() { clearTimeout(timer); signal.removeEventListener('abort', wake); cleanup(); resolve(); }
          const cleanup = () => { for (const id of childIds) this.waiters.get(id)?.delete(wake); };
          for (const id of childIds) {
            if (!this.waiters.has(id)) this.waiters.set(id, new Set());
            this.waiters.get(id)!.add(wake);
          }
          signal.addEventListener('abort', wake, { once: true });
        });
      }
      return true;
    } finally {
      for (const id of childIds) {
        const count = (this.awaited.get(id) ?? 1) - 1;
        if (count) this.awaited.set(id, count); else this.awaited.delete(id);
      }
    }
  }

  /** Marks reports as received by the master through a tool call, so they do not also arrive as a message. */
  received(tasks: AgentTask[]): void {
    this.tasks.delivered(tasks.map(task => task.id));
    for (const task of tasks) this.deliverable.delete(task.id);
    if (tasks.length) this.changed(tasks[0].master_session_id);
  }

  schedule(masterId: string): Promise<void> {
    const scheduled = this.timers.get(masterId);
    if (scheduled) return scheduled;
    const delivery = delay(orchestrationConstants.deliveryDelayMs, undefined, { ref: false }).then(() => {
      this.timers.delete(masterId);
      return this.deliver(masterId, false);
    });
    this.timers.set(masterId, delivery);
    return delivery;
  }

  private async maybeAutoRollover(session: Session): Promise<void> {
    const { id } = session;
    if (this.rollovers.has(id)) return;
    const { agents, store } = this.context;
    const rollover = rolloverSession(this.context, session.user_id, id, {
      automatic: true, contextTokens: session.last_context_tokens,
      canRollover: current => {
        const runtime = agents.view(id);
        return current.status === 'completed' && current.native_session_id === session.native_session_id && needsRollover(current)
          && !runtime.turnActive && !runtime.switching && !runtime.queue.length && !agents.hasBackgroundWork(id)
          && !agents.questions.list(id).length && !store.get('SELECT 1 FROM deferred_questions WHERE session_id=? LIMIT 1', id)
          && !store.get("SELECT 1 FROM approvals WHERE session_id=? AND status='pending' LIMIT 1", id)
          && !this.timers.has(id) && (!this.automaticReports(id).length || this.atQuota(id));
      },
    });
    this.rollovers.set(id, rollover);
    try { await rollover; } finally { this.rollovers.delete(id); }
  }

  sessionDeleted(id: string, masterId: string | null): void {
    this.clearDeferred(id);
    this.errors.delete(id);
    this.paused.delete(id);
    this.quotaAnchor.delete(id);
    if (masterId) {
      // The foreign-key cascade may have removed the last running task in a wave.
      for (const wake of this.waiters.get(id) ?? []) wake();
      this.changed(masterId);
      this.schedule(masterId);
    }
  }

  atQuota(masterId: string): boolean {
    const anchor = this.quotaAnchor.get(masterId);
    // A queued manual report uses its queue ID as its message ID when its turn starts.
    if (anchor && this.context.agents.view(masterId).queue.some(input => input.id === anchor)) return false;
    return this.tasks.reportTurnsSinceUser(masterId, anchor) >= this.context.orchestrationSettings.view().reportTurnsPerMessage;
  }

  /** `manual` is the user delivering from the agent panel: it includes reports from before a restart and ignores the turn limit. */
  async deliver(masterId: string, manual: boolean): Promise<void> {
    // A child can finish while the resident process is closing under the master's session lock.
    const rollover = this.rollovers.get(masterId);
    if (rollover) await rollover.catch(() => undefined);
    const { store, events } = this.context;
    const master = store.get<Session>('SELECT * FROM sessions WHERE id=?', masterId);
    const user = master && store.get<User>('SELECT * FROM users WHERE id=?', master.user_id);
    if (!master || !user) return;
    const pending = manual ? this.tasks.pending(masterId) : this.automaticReports(masterId);
    if (!pending.length) return;
    if (!manual && this.atQuota(masterId)) {
      if (!this.paused.has(masterId)) {
        this.paused.add(masterId);
        events.emit(user.id, { type: 'notice', sessionId: masterId, payload: {
          message: `自动汇总已达 ${this.context.orchestrationSettings.view().reportTurnsPerMessage} 次，后续子智能体汇报已暂停，可在子智能体面板中手动投递。` } });
        this.changed(masterId);
      }
      return;
    }
    const children = new Map(this.tasks.children(masterId).map(child => [child.id, child]));
    const superAgent = orchestrationModeOf(master) === 'super';
    let content = '';
    let promptContent = '';
    const sent: AgentTask[] = [];
    const batches = new Map<string, AgentTask[]>();
    for (const task of pending) {
      if (!children.has(task.child_session_id)) continue;
      const key = !manual && task.wave && task.status === 'completed' ? `wave:${task.wave}` : task.id;
      const batch = batches.get(key);
      if (batch) batch.push(task); else batches.set(key, [task]);
    }
    for (const batch of batches.values()) {
      const block = formatBatch(batch.map(task => reportSource(children.get(task.child_session_id)!, task)), superAgent);
      if (content && content.length + 2 + block.content.length > messageLimit) break;
      content += (content ? '\n\n' : '') + block.content;
      promptContent += (promptContent ? '\n\n' : '') + block.prompt;
      sent.push(...batch.slice(0, block.count));
      if (block.count < batch.length) break;
    }
    try {
      const { messageId } = await sendSessionMessage(this.context, user, masterId, messageInput.parse({ content, mode: 'queue' }),
        { source: 'report', prompt: () => promptContent });
      if (manual) this.quotaAnchor.set(masterId, messageId);
      this.paused.delete(masterId);
      this.received(sent);
      this.deliveredTasks?.(user, master, sent);
      if (sent.length < pending.length) {
        if (manual) await this.deliver(masterId, true);
        else this.schedule(masterId);
      }
    } catch (error) {
      events.emit(user.id, { type: 'error', sessionId: masterId,
        payload: { message: `子智能体汇报未能送达主智能体，已保留在子智能体面板中：${error instanceof Error ? error.message : String(error)}` } });
      this.changed(masterId);
    }
  }

  private automaticReports(masterId: string): AgentTask[] {
    return this.tasks.pending(masterId).filter(task => this.deliverable.has(task.id) && !this.awaited.has(task.child_session_id)
      && (!task.wave || task.status !== 'completed' || !this.tasks.waveRunning(masterId, task.wave)));
  }
}

export function reportSource(child: Session, task: AgentTask): ReportSource {
  return { name: child.agent_name ?? child.id, engine: child.engine, model: child.model,
    status: task.status, task: task.prompt, text: task.report ?? '' };
}
