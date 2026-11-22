import type { Context } from '../context.js';
import type { Session, User } from '../models.js';
import type { AgentEvent } from '../agent/types.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { reportBlock } from './instructions.js';
import { orchestrationConstants } from './limits.js';
import type { AgentTask, AgentTasks } from './tasks.js';

const finishedStatuses = new Set(['completed', 'interrupted', 'error']);
const fallbackReports: Record<string, string> = {
  completed: '子智能体没有给出最终回复。',
  interrupted: '子智能体的执行被中断，没有给出最终回复。',
  error: '子智能体出错，没有给出最终回复。',
};

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
  private timers = new Map<string, NodeJS.Timeout>();
  private paused = new Set<string>();

  constructor(private readonly context: Context, private readonly tasks: AgentTasks, private readonly changed: (masterId: string) => void) {}

  observe(event: AgentEvent): void {
    const payload = event.payload as { status?: string; message?: string; turnId?: string } | undefined;
    if (event.type === 'error' && payload?.message) this.errors.set(event.sessionId, payload.message);
    if (event.type !== 'turn-state' || !finishedStatuses.has(payload?.status ?? '')) return;
    const session = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=?', event.sessionId);
    if (!session) return;
    if (session.orchestration) this.schedule(session.id);
    if (session.parent_session_id) this.childTurnEnded(session, payload!.status as 'completed' | 'interrupted' | 'error', payload!.turnId);
  }

  private childTurnEnded(child: Session, status: 'completed' | 'interrupted' | 'error', turnId?: string): void {
    // Called before the manager starts the next queued message, so a queue still holds what comes next.
    const runtime = this.context.agents.view(child.id);
    if (runtime.switching || runtime.queue.length || (status === 'completed' && runtime.tasks.length)) return;
    if (!this.tasks.running(child.id).length) return;
    const answer = turnId ? this.context.store.get<{ content: string }>(`SELECT messages.content FROM session_turns
      JOIN messages ON messages.id=session_turns.assistant_message_id WHERE session_turns.id=?`, turnId)?.content : undefined;
    const error = this.errors.get(child.id);
    this.errors.delete(child.id);
    const failure = status === 'error' ? `\n\n[子智能体出错：${error ?? '未知错误'}]` : '';
    void this.complete(child, status, (answer?.trim() || fallbackReports[status]) + (answer ? failure : failure.trimStart()));
  }

  /** Ends the child's tasks; a child in its own worktree first gets its work committed, and the report says where it is. */
  async complete(child: Session, status: 'completed' | 'interrupted' | 'error', report: string): Promise<void> {
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

  schedule(masterId: string): void {
    if (this.timers.has(masterId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(masterId);
      void this.deliver(masterId, false);
    }, orchestrationConstants.deliveryDelayMs);
    timer.unref();
    this.timers.set(masterId, timer);
  }

  /** `manual` is the user delivering from the agent panel: it includes reports from before a restart and ignores the turn limit. */
  async deliver(masterId: string, manual: boolean): Promise<void> {
    const { store, events } = this.context;
    const master = store.get<Session>('SELECT * FROM sessions WHERE id=?', masterId);
    const user = master && store.get<User>('SELECT * FROM users WHERE id=?', master.user_id);
    if (!master || !user) return;
    const pending = this.tasks.pending(masterId).filter(task => manual || (this.deliverable.has(task.id) && !this.awaited.has(task.child_session_id)));
    if (!pending.length) return;
    const { reportTurnsPerMessage } = this.context.orchestrationSettings.view();
    if (!manual && this.tasks.reportTurnsSinceUser(masterId) >= reportTurnsPerMessage) {
      if (!this.paused.has(masterId)) {
        this.paused.add(masterId);
        events.emit(user.id, { type: 'notice', sessionId: masterId, payload: {
          message: `主智能体在你上一条消息之后已自动汇总 ${reportTurnsPerMessage} 次，后续子智能体汇报已暂停，可在子智能体面板中手动投递。` } });
        this.changed(masterId);
      }
      return;
    }
    const children = new Map(this.tasks.children(masterId).map(child => [child.id, child]));
    let content = '';
    const sent: AgentTask[] = [];
    for (const task of pending) {
      const child = children.get(task.child_session_id);
      if (!child) continue;
      const block = reportBlock({ name: child.agent_name ?? child.id, engine: child.engine, model: child.model, status: task.status,
        task: task.prompt, text: task.report ?? '' });
      if (content && content.length + block.length > 90_000) break;
      content += (content ? '\n\n' : '') + block;
      sent.push(task);
    }
    try {
      await sendSessionMessage(this.context, user, masterId, messageInput.parse({ content, mode: 'queue' }), { source: 'report', prompt: text => text });
      this.paused.delete(masterId);
      this.received(sent);
      if (sent.length < pending.length) this.schedule(masterId);
    } catch (error) {
      events.emit(user.id, { type: 'error', sessionId: masterId,
        payload: { message: `子智能体汇报未能送达主智能体，已保留在子智能体面板中：${error instanceof Error ? error.message : String(error)}` } });
      this.changed(masterId);
    }
  }
}
