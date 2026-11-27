import { randomUUID } from 'node:crypto';
import { agentHostInfo, projectFor, sessionFor, type Context } from '../../context.js';
import { HttpError, type Session, type Slot, type User } from '../../models.js';
import { slotForUser } from '../../accounts/access.js';
import { resolveAgentSelection, validateAgentSelection } from '../model-catalog.js';
import type { AgentContext } from '../types.js';
import { BtwStore } from './store.js';
import { buildBtwContextSnapshot } from './context.js';
import { runClaudeBtw } from './claude.js';
import { runCodexBtw } from './codex.js';
import { runAntigravityBtw } from './antigravity.js';
import type { BtwEngineInput, BtwEventPayload, BtwExchange } from './types.js';

const MAX_ACTIVE_PER_SESSION = 3;
const FLUSH_INTERVAL_MS = 250;

interface ActiveBtw {
  id: string;
  sessionId: string;
  userId: string;
  abort: AbortController;
  done: Promise<void>;
}

export interface BtwAskOptions {
  slotId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

const coldRunners = {
  claude: runClaudeBtw,
  codex: runCodexBtw,
  antigravity: runAntigravityBtw,
};

/**
 * Orchestrates read-only `/btw` side questions across Claude Code, Codex, and Antigravity.
 * Never writes to `messages` or `session_turns`, never locks `session:${id}`, never triggers
 * account failover, and uses `runtime_kind: 'probe'` leases whenever spawning cold/side CLIs.
 */
export class BtwService {
  readonly store: BtwStore;
  private active = new Map<string, ActiveBtw>();

  constructor(private context: Context) {
    this.store = new BtwStore(context.store);
  }

  list(sessionId: string): BtwExchange[] {
    return this.store.list(sessionId);
  }

  async ask(user: User, sessionId: string, question: string, options: BtwAskOptions = {}): Promise<BtwExchange> {
    if (this.context.maintenance.isEnabled()) {
      throw new HttpError(503, this.context.maintenance.blockMessage());
    }
    const trimmed = question.trim();
    if (!trimmed) throw new HttpError(400, '请输入旁路提问内容');
    const session = sessionFor(this.context, sessionId, user.id);
    if (session.archived_at) throw new HttpError(409, '对话已归档，请先恢复后再提问');

    const runningForSession = [...this.active.values()].filter(item => item.sessionId === sessionId).length;
    if (runningForSession >= MAX_ACTIVE_PER_SESSION) {
      throw new HttpError(409, `同一对话最多同时进行 ${MAX_ACTIVE_PER_SESSION} 条旁路提问，请等待完成或取消后再试`);
    }

    const resident = this.context.agents.residentForBtw(sessionId);
    const { slot, model, reasoningEffort, agentContext } = await this.resolveExecutionTarget(user, session, resident?.context, options);

    const id = randomUUID();
    const created = this.store.create({
      id,
      sessionId,
      question: trimmed,
      engine: session.engine,
      model,
      slotId: slot.id,
    });
    this.publish(user.id, sessionId, { action: 'upsert', exchange: created });

    const abort = new AbortController();
    const done = this.execute({
      id,
      userId: user.id,
      session,
      agentContext,
      resident,
      question: trimmed,
      signal: abort.signal,
    }).finally(() => {
      if (this.active.get(id)?.abort === abort) this.active.delete(id);
    });
    this.active.set(id, { id, sessionId, userId: user.id, abort, done });
    return created;
  }

  cancel(userId: string, sessionId: string, btwId: string): BtwExchange {
    const existing = this.store.get(sessionId, btwId);
    if (!existing) throw new HttpError(404, '旁路提问记录不存在');
    const active = this.active.get(btwId);
    if (active && active.sessionId === sessionId) {
      active.abort.abort();
    }
    if (existing.status === 'running') {
      const updated = this.store.finish(sessionId, btwId, 'cancelled', { error: null }) ?? existing;
      this.publish(userId, sessionId, { action: 'upsert', exchange: updated });
      return updated;
    }
    return existing;
  }

  cancelSession(sessionId: string): void {
    for (const item of this.active.values()) {
      if (item.sessionId !== sessionId) continue;
      item.abort.abort();
      const updated = this.store.finish(sessionId, item.id, 'cancelled', { error: null });
      if (updated) this.publish(item.userId, sessionId, { action: 'upsert', exchange: updated });
    }
  }

  remove(userId: string, sessionId: string, btwId: string): void {
    const existing = this.store.get(sessionId, btwId);
    if (!existing) throw new HttpError(404, '旁路提问记录不存在');
    if (existing.status === 'running') this.cancel(userId, sessionId, btwId);
    this.store.remove(sessionId, btwId);
    this.publish(userId, sessionId, { action: 'delete', id: btwId });
  }

  async close(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const item of this.active.values()) {
      item.abort.abort();
      tasks.push(item.done);
    }
    await Promise.allSettled(tasks);
  }

  private publish(userId: string, sessionId: string, payload: BtwEventPayload): void {
    this.context.events.broadcast(userId, { type: 'btw', sessionId, payload });
  }

  private async resolveExecutionTarget(
    user: User,
    session: Session,
    residentContext: AgentContext | undefined,
    options: BtwAskOptions,
  ): Promise<{ slot: Slot; model: string | null; reasoningEffort: string | null; agentContext: AgentContext }> {
    const project = projectFor(this.context, session.project_id, user.id);
    const host = agentHostInfo(this.context, project.dev_host_id, user.id);

    if (residentContext && residentContext.session.engine === session.engine) {
      const slot = slotForUser(this.context.store, residentContext.slot.id, user.id, session.engine);
      const model = residentContext.session.model ?? session.model ?? null;
      const reasoningEffort = residentContext.session.reasoning_effort ?? session.reasoning_effort ?? null;
      return {
        slot,
        model,
        reasoningEffort,
        agentContext: {
          ...residentContext,
          runtime_kind: 'probe',
          project,
          host,
          slot,
          session: { ...session, model, reasoning_effort: reasoningEffort },
        },
      };
    }

    const activeSlotId = this.context.config.credentials.activeSlotForUser(user.id, session.engine);
    let slot: Slot | undefined;
    if (activeSlotId) {
      try { slot = slotForUser(this.context.store, activeSlotId, user.id, session.engine); } catch { slot = undefined; }
    }
    if (!slot) {
      const candidateId = options.slotId || session.slot_id;
      if (candidateId) {
        try {
          const candidate = slotForUser(this.context.store, candidateId, user.id, session.engine);
          if (candidate.status === 'IDLE') slot = candidate;
        } catch { slot = undefined; }
      }
    }
    if (!slot && session.slot_mode === 'auto') {
      const preferredModel = options.model !== undefined ? options.model : session.model;
      slot = await this.context.slots.select(
        { userId: user.id, engine: session.engine, model: preferredModel, preferredSlotId: session.slot_id },
        candidate => validateAgentSelection(
          this.context.config,
          { user, slot: candidate, session: { engine: session.engine } },
          { model: preferredModel, reasoningEffort: session.reasoning_effort },
        ),
      );
    }
    if (!slot) throw new HttpError(409, '请先为当前对话选择可用授权槽位');

    const desiredModel = options.model !== undefined ? options.model : session.model;
    const desiredEffort = options.reasoningEffort !== undefined ? options.reasoningEffort : session.reasoning_effort;
    let model = desiredModel ?? null;
    let reasoningEffort = desiredEffort ?? null;
    try {
      const resolved = await resolveAgentSelection(
        this.context.config,
        { user, slot, session },
        { model: desiredModel, reasoningEffort: desiredEffort },
        this.context.agentDefaults.forUser(user.id, session.engine),
        false,
      );
      model = resolved.model;
      reasoningEffort = resolved.reasoningEffort;
    } catch {
      // Fall back to the session's configured selection when a catalog probe cannot run right now.
    }

    const agentContext: AgentContext = {
      runtime_home: slot.home_dir,
      runtime_kind: 'probe',
      user,
      project,
      host,
      slot,
      session: { ...session, model, reasoning_effort: reasoningEffort },
    };
    return { slot, model, reasoningEffort, agentContext };
  }

  private async execute(input: {
    id: string;
    userId: string;
    session: Session;
    agentContext: AgentContext;
    resident: ReturnType<Context['agents']['residentForBtw']>;
    question: string;
    signal: AbortSignal;
  }): Promise<void> {
    const { id, userId, session, agentContext, resident, question, signal } = input;
    let answer = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const flushAnswer = () => {
      flushTimer = undefined;
      this.store.updateAnswer(id, answer);
    };
    const onDelta = (chunk: string) => {
      if (!chunk || signal.aborted) return;
      answer += chunk;
      this.publish(userId, session.id, { action: 'delta', id, delta: chunk });
      if (!flushTimer) {
        flushTimer = setTimeout(flushAnswer, FLUSH_INTERVAL_MS);
        flushTimer.unref();
      }
    };

    try {
      const snapshot = buildBtwContextSnapshot(this.context.store, this.context.turns, session.id);
      const history = this.store.recentCompleted(session.id, 6, id);
      let finalAnswer = '';

      if (resident?.run.sideQuestion && (session.engine === 'claude' || session.engine === 'codex')) {
        const residentAnswer = await resident.run.sideQuestion(question, signal, { history, snapshot, onDelta });
        if (residentAnswer !== null && residentAnswer !== undefined) {
          finalAnswer = residentAnswer;
          if (!answer && finalAnswer) onDelta(finalAnswer);
        } else if (!signal.aborted) {
          finalAnswer = await this.runWithProbeLease(agentContext, {
            config: this.context.config,
            context: agentContext,
            question,
            history,
            snapshot,
            signal,
            onDelta,
          });
        }
      } else {
        finalAnswer = await this.runWithProbeLease(agentContext, {
          config: this.context.config,
          context: agentContext,
          question,
          history,
          snapshot,
          signal,
          onDelta,
        });
      }

      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      if (signal.aborted) {
        const updated = this.store.finish(session.id, id, 'cancelled', { answer: answer || finalAnswer, error: null });
        if (updated) this.publish(userId, session.id, { action: 'upsert', exchange: updated });
        return;
      }
      const completedText = (answer || finalAnswer).trim() || '（未返回文本内容）';
      const updated = this.store.finish(session.id, id, 'completed', { answer: completedText, error: null });
      if (updated) this.publish(userId, session.id, { action: 'upsert', exchange: updated });
    } catch (error) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const status = cancelled ? 'cancelled' : 'error';
      const message = cancelled ? null : (error instanceof Error ? error.message : '旁路提问执行失败');
      const updated = this.store.finish(session.id, id, status, { answer, error: message });
      if (updated) this.publish(userId, session.id, { action: 'upsert', exchange: updated });
    }
  }

  private async runWithProbeLease(agentContext: AgentContext, engineInput: BtwEngineInput): Promise<string> {
    await this.context.config.egress?.assertBound(agentContext.slot.id);
    const release = await this.context.config.credentials.acquire({ ...agentContext, runtime_kind: 'probe' });
    try {
      return await coldRunners[agentContext.session.engine](engineInput);
    } finally {
      await release();
    }
  }
}
