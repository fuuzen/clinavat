import { setTimeout as delay } from 'node:timers/promises';
import type { ActiveRun, RunContinuation, RuntimeView } from './resident-run.js';
import type { AgentCallbacks, AgentContext, QueuedInput, QuotaFailure } from './types.js';

const MAX_SWITCHES = 3;
const continuationPrompt = '继续当前任务。先检查已有文件、任务和工具执行结果，确认哪些步骤已完成；不要重复已经产生副作用的操作，再完成尚未完成的工作。';

interface PendingSwitch {
  state: ActiveRun;
  quota?: QuotaFailure;
  attemptedSlotIds: string[];
  queue: QueuedInput[];
  abort: AbortController;
  operation?: Promise<void>;
  superseded?: boolean;
  failureReason?: string;
  terminal?: boolean;
}

function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('会话已停止', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

interface FailoverHost {
  current(sessionId: string): ActiveRun | undefined;
  start(context: AgentContext, prompt: string, continuation: RunContinuation): Promise<void>;
  close(state: ActiveRun): void;
  publish(state: ActiveRun): void;
}

/** Owns the gap between two resident processes, including Stop and unsent input during that gap. */
export class RuntimeFailovers {
  private pending = new Map<string, PendingSwitch>();
  private retained = new Map<string, QueuedInput[]>();
  private preparations = new Set<Promise<AgentContext>>();

  constructor(private callbacks: AgentCallbacks, private host: FailoverHost) {}

  has(sessionId: string): boolean { return this.pending.has(sessionId); }
  matches(filter: { projectId?: string; userId?: string }): boolean {
    return [...this.pending.values()].some(({ state }) => (!filter.projectId || state.projectId === filter.projectId)
      && (!filter.userId || state.userId === filter.userId));
  }

  queue(sessionId: string): QueuedInput[] | undefined {
    const pending = this.pending.get(sessionId);
    if (pending) return pending.queue;
    if (this.host.current(sessionId)) return undefined;
    if (!this.retained.has(sessionId)) {
      const saved = this.callbacks.loadQueuedInputs?.(sessionId);
      if (saved?.length) this.retained.set(sessionId, saved);
    }
    return this.retained.get(sessionId);
  }

  retainQueue(sessionId: string, queue: QueuedInput[]): void {
    if (queue.length) this.retained.set(sessionId, queue);
  }
  takeQueue(sessionId: string): QueuedInput[] {
    const queue = this.queue(sessionId) ?? [];
    this.retained.delete(sessionId);
    return queue;
  }

  view(sessionId: string): RuntimeView | undefined {
    const pending = this.pending.get(sessionId);
    const queue = this.queue(sessionId);
    if (!pending && !queue?.length) return undefined;
    return {
      resident: !!pending,
      turnActive: !!pending?.state.turnActive,
      queue: (queue ?? []).map(({ id, content, queuedAt }) => ({ id, content, queuedAt })),
      tasks: pending?.state.run?.tasks() ?? [],
      ...(pending?.terminal ? { settling: true } : pending ? { switching: { fromSlotId: pending.state.slotId, attempt: Math.min(MAX_SWITCHES, pending.attemptedSlotIds.length),
        waitingForTasks: !pending.state.closing && !pending.state.run?.isIdle() } } : {}),
    };
  }

  begin(state: ActiveRun, quota: QuotaFailure): boolean {
    try { this.callbacks.quotaReached?.(state.context, quota); }
    catch (error) {
      this.callbacks.event({ type: 'error', sessionId: state.context.session.id,
        payload: { message: `无法保存账号额度状态：${error instanceof Error ? error.message : String(error)}` } });
      return false;
    }
    const sessionId = state.context.session.id;
    if (state.context.session.engine !== 'claude' || state.context.session.slot_mode !== 'auto'
      || state.context.session.command || !this.callbacks.prepareFailover || state.abort.signal.aborted) return false;
    const existing = this.pending.get(sessionId);
    if (existing) { existing.quota = quota; return !existing.terminal && existing.state === state; }
    const attemptedSlotIds = [...new Set([...state.attemptedSlotIds, state.slotId])];
    const pending: PendingSwitch = { state, quota, attemptedSlotIds, queue: state.queue, abort: new AbortController(),
      ...(attemptedSlotIds.length > MAX_SWITCHES ? { failureReason: `已达到自动切换账号次数上限（${MAX_SWITCHES} 次）` } : {}) };
    this.pending.set(sessionId, pending);
    pending.operation = this.switch(pending);
    void pending.operation.catch(() => undefined);
    return true;
  }

  halt(state: ActiveRun): void {
    const sessionId = state.context.session.id;
    const existing = this.pending.get(sessionId);
    if (existing) { existing.terminal = true; return; }
    const pending: PendingSwitch = { state, attemptedSlotIds: state.attemptedSlotIds,
      queue: state.queue, abort: new AbortController(), terminal: true };
    this.pending.set(sessionId, pending);
    pending.operation = this.switch(pending);
    void pending.operation.catch(() => undefined);
  }

  // A native background turn can finish or fail differently while hand-over is waiting for it.
  supersede(state: ActiveRun): void {
    const pending = this.pending.get(state.context.session.id);
    if (pending?.state !== state || pending.terminal) return;
    pending.superseded = true;
    pending.abort.abort();
    this.pending.delete(state.context.session.id);
  }

  stop(sessionId: string, preserveQueue = false): Promise<void> {
    if (!preserveQueue) this.retained.delete(sessionId);
    const pending = this.pending.get(sessionId);
    if (!pending) return Promise.resolve();
    if (preserveQueue) this.retainQueue(sessionId, pending.queue);
    else pending.queue.length = 0;
    pending.abort.abort();
    return pending.operation ?? Promise.resolve();
  }

  async close(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(sessionId => this.stop(sessionId, true)));
    await Promise.allSettled([...this.preparations]);
  }

  private async switch(pending: PendingSwitch): Promise<void> {
    const { state, abort } = pending;
    const sessionId = state.context.session.id;
    let context = state.context;
    let handedOff = false;
    try {
      await state.startup;
      abort.signal.throwIfAborted();
      // isIdle also checks native queued steering and background tasks. Never interrupt either to rotate an account.
      while (!state.finishing && (state.turnActive || !state.run?.isIdle())) {
        await delay(100, undefined, { signal: abort.signal });
      }
      await state.flushes;
      abort.signal.throwIfAborted();
      if (state.flushError) throw state.flushError;
      if (!state.finishing) {
        if (state.turnActive || !state.run?.isIdle()) throw new Error('工具或后台任务重新开始，账号尚不能安全切换');
        this.host.close(state);
      }
      await state.completion;
      abort.signal.throwIfAborted();
      if (state.credentialError) throw state.credentialError;
      if (state.completionError) throw state.completionError;
      if (state.flushError) throw state.flushError;
      if (pending.terminal) { this.retainQueue(sessionId, pending.queue); return; }
      if (pending.failureReason) throw new Error(pending.failureReason);
      // A probe may need to boot a VM. Stop returns without waiting for that boot; the callback must check
      // this signal after each await before persisting a new turn, while its own finally releases probes.
      const preparation = this.callbacks.prepareFailover!(state.context, pending.quota!, pending.attemptedSlotIds, abort.signal);
      this.preparations.add(preparation);
      void preparation.then(() => this.preparations.delete(preparation), () => this.preparations.delete(preparation));
      context = await cancellable(preparation, abort.signal);
      abort.signal.throwIfAborted();
      if (pending.attemptedSlotIds.includes(context.slot.id)) throw new Error('自动切换不能重复尝试已耗尽的账号');
      // start reserves its ActiveRun synchronously, so removing this placeholder leaves no observable idle gap.
      if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId);
      handedOff = true;
      await this.host.start(context, continuationPrompt, { queue: pending.queue, attemptedSlotIds: pending.attemptedSlotIds });
    } catch (error) {
      if (pending.superseded) return;
      const interrupted = abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        || (handedOff && !!this.host.current(sessionId)?.abort.signal.aborted);
      if (!interrupted) this.retainQueue(sessionId, pending.queue);
      if (!interrupted && this.host.current(sessionId) === state && !state.turnActive && state.run?.isIdle()) {
        this.host.close(state);
        await state.completion?.catch(cleanupError => { error = cleanupError; });
        if (state.credentialError) error = state.credentialError;
      }
      const status = interrupted ? 'interrupted' : 'error';
      await this.callbacks.updateSession(sessionId, { status });
      this.callbacks.event({ type: 'turn-state', sessionId, payload: { turnId: context.session.turn_id, status } });
      if (!interrupted) this.callbacks.event({ type: 'error', sessionId, payload: {
        message: `${pending.terminal ? '账号运行状态回收失败' : '自动切换账号失败'}：${error instanceof Error ? error.message : String(error)}`,
      } });
      this.callbacks.event({ type: 'done', sessionId, payload: { stopped: interrupted, failed: !interrupted } });
    } finally {
      if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId);
      this.host.publish(state);
    }
  }
}
