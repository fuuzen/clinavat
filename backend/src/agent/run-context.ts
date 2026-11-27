import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { openContained } from '../runtime/contained-files.js';
import { clientDirectEmptyDir } from './environment.js';
import { isClientDirect } from './orchestration-tools.js';
import { getPermissionMode } from './permissions.js';
import { RunControl } from './run-control.js';
import { rescueUnconsumedSteers, settingsKey, type ActiveRun, type RunContinuation } from './resident-run.js';
import type { UserInputRequests } from './user-input.js';
import type {
  AgentCallbacks, AgentConfig, AgentContext, ApprovalDecision, QueuedInput, RunServices, TurnOrigin, TurnOutcome,
} from './types.js';

export async function shellHash(context: AgentContext): Promise<string | null> {
  if (isClientDirect(context)) return null;
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

/** Captures the project's executor hash at startup and verifies it remains unchanged before sensitive steps. */
export async function createShellVerifier(
  config: AgentConfig, context: AgentContext, signal: AbortSignal,
): Promise<() => Promise<void>> {
  if (isClientDirect(context)) {
    await mkdir(clientDirectEmptyDir(config.workspaceDir), { recursive: true, mode: 0o700 });
    context.project.host_shell = null;
    return async () => {
      if (signal.aborted) throw new Error('会话已停止');
    };
  }
  context.project.host_shell = await config.hostShell?.(context) ?? null;
  const expectedShellHash = await shellHash(context);
  return async () => {
    if (signal.aborted) throw new Error('会话已停止');
    if (await shellHash(context) !== expectedShellHash) throw new Error('项目执行环境已被修改，请重新打开项目以恢复');
    if (signal.aborted) throw new Error('会话已停止');
  };
}

export function awaitApproval(callbacks: AgentCallbacks, timeout: number, sessionId: string, tool: string,
  input: Record<string, unknown>, signal: AbortSignal, control: RunControl): Promise<ApprovalDecision> {
  if (signal.aborted) return Promise.resolve({ decision: 'deny', reason: '审批已取消' });
  const request = new AbortController();
  return new Promise(resolve => {
    let settled = false;
    const finish = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      signal.removeEventListener('abort', abort);
      request.abort();
      resolve(decision);
    };
    const abort = () => finish({ decision: 'deny', reason: '审批已停止' });
    const cancelTimeout = control.timer(() => finish({ decision: 'deny', reason: '审批超时，已自动拒绝' }), timeout);
    signal.addEventListener('abort', abort, { once: true });
    void callbacks.approval({ sessionId, tool, input, signal: request.signal,
      scheduleTimeout: (callback, milliseconds) => control.timer(callback, milliseconds) }).then(finish)
      .catch(() => finish({ decision: 'deny', reason: '审批服务不可用，已拒绝' }));
  });
}

export interface CredentialLeaseTracker {
  set(release: () => Promise<void>): void;
  release(): Promise<void>;
  readonly failed: boolean;
}

export function createCredentialLeaseTracker(state: ActiveRun): CredentialLeaseTracker {
  let releaseLease: (() => Promise<void>) | undefined;
  let failed = false;
  return {
    set(release) { releaseLease = release; },
    async release() {
      const release = releaseLease;
      releaseLease = undefined;
      try { await release?.(); }
      catch (error) {
        failed = true;
        state.credentialError = error instanceof Error ? error : new Error('槽位运行状态回收失败');
        throw state.credentialError;
      }
    },
    get failed() { return failed; },
  };
}

export function createActiveRun(
  context: AgentContext, queue: QueuedInput[], continuation: RunContinuation | undefined,
  callbacks: AgentCallbacks, isCurrent: (state: ActiveRun) => boolean,
): { state: ActiveRun; startupDone: () => void } {
  let startupDone!: () => void;
  const startup = new Promise<void>(resolve => { startupDone = resolve; });
  const state: ActiveRun = {
    userId: context.user.id, projectId: context.project.id, slotId: context.slot.id, context,
    settings: settingsKey(context), abort: new AbortController(), startup, control: new RunControl(),
    turnActive: true, queue, pendingSteers: [], attemptedSlotIds: continuation?.attemptedSlotIds ?? [], flushes: Promise.resolve(),
  };
  const sessionId = context.session.id;
  state.control.subscribe(status => {
    if (state.finishing || state.abort.signal.aborted || !state.turnActive || !isCurrent(state)) return;
    void callbacks.updateSession(sessionId, { status: state.halted ? 'error' : status });
    callbacks.event({ type: 'turn-state', sessionId, payload: { turnId: context.session.turn_id, status } });
  });
  return { state, startupDone };
}

export interface RunServiceHooks {
  config: AgentConfig; callbacks: AgentCallbacks; questions: UserInputRequests; state: ActiveRun;
  turnEnded: (outcome: TurnOutcome) => void; automaticTurn: (origin: TurnOrigin) => void;
  steered: (messageId: string) => void; activityChanged: () => void;
}

export function buildRunServices(hooks: RunServiceHooks): RunServices {
  const { config, callbacks, questions, state } = hooks;
  const { context } = state;
  const sessionId = context.session.id;
  return {
    config, context, control: state.control,
    event: (type, payload) => callbacks.event({
      type, sessionId, payload: payload && typeof payload === 'object' ? { ...payload, turnId: context.session.turn_id } : payload,
    }),
    update: async (fields) => { await callbacks.updateSession(sessionId, fields); Object.assign(context.session, fields); },
    approve: async (tool, input, requestSignal) => {
      const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
      if (signal.aborted) return { decision: 'deny', reason: '审批已取消' };
      await state.control.waitUntilRunning(signal);
      const decision: ApprovalDecision = getPermissionMode(context.session) === 'yolo' && context.session.agent_mode !== 'plan'
        ? { decision: 'allow', reason: 'YOLO：本系统自动批准' }
        : await awaitApproval(callbacks, config.approvalTimeoutMs, sessionId, tool, input, signal, state.control);
      await state.control.waitUntilRunning(signal);
      return decision;
    },
    ask: async (items, requestSignal) => {
      const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
      await state.control.waitUntilRunning(signal);
      const outcome = await questions.request(sessionId, items, signal, {
        policy: callbacks.questionPolicy(sessionId),
        schedule: (callback, milliseconds) => state.control.timer(callback, milliseconds),
        defer: question => callbacks.deferQuestion(question),
      });
      await state.control.waitUntilRunning(signal);
      return outcome;
    },
    verifyShell: async () => {
      await state.control.waitUntilRunning(state.abort.signal);
      await state.verifyShell!();
      await state.control.waitUntilRunning(state.abort.signal);
    },
    turnEnded: hooks.turnEnded, automaticTurn: hooks.automaticTurn, steered: hooks.steered, activityChanged: hooks.activityChanged,
    recordTokenUsage: update => callbacks.recordTokenUsage?.({
      userId: context.user.id, slotId: context.slot.id, sessionId, turnId: context.session.turn_id ?? null, engine: context.session.engine,
    }, update),
  };
}

/** Acquires egress/credential lease, captures shell hash and slot identity, and assembles RunServices before CLI spawn. */
export async function prepareRunServices(hooks: RunServiceHooks, lease: CredentialLeaseTracker): Promise<RunServices> {
  const { config, callbacks, state } = hooks;
  const { context } = state;
  await config.egress?.assertBound(context.slot.id);
  lease.set(await config.credentials.acquire(context));
  if (state.abort.signal.aborted) throw new Error('会话已停止');
  state.verifyShell = await createShellVerifier(config, context, state.abort.signal);
  if (context.session.slot_mode === 'auto') await callbacks.verifyAutomaticSlot?.(context);
  if (state.abort.signal.aborted) throw new Error('会话已停止');
  const services = buildRunServices(hooks);
  context.account_identity = await config.usage?.captureIdentity(context.slot) ?? null;
  if (state.abort.signal.aborted) throw new DOMException('会话已停止', 'AbortError');
  if (context.session.slot_mode === 'auto') {
    if (!callbacks.assertAutomaticSlot) throw new Error('自动账号额度复核尚未配置');
    callbacks.assertAutomaticSlot(context);
  }
  return services;
}

export interface RunTeardownHooks {
  callbacks: AgentCallbacks; lease: CredentialLeaseTracker; isClosing: () => boolean;
  retainQueue: (sessionId: string, queue: QueuedInput[]) => void;
  clearActive: (sessionId: string, state: ActiveRun) => void;
  emitError: (state: ActiveRun, message: string) => void;
  publish: (state: ActiveRun) => void;
}

/** Wires process completion cleanup: releases slot lease, settles any open turn, and retains unsent queue items. */
export function attachRunCompletion(state: ActiveRun, services: RunServices, hooks: RunTeardownHooks): Promise<void> {
  const sessionId = state.context.session.id;
  // A turn ends through turnEnded; the process ending only settles a turn the CLI left open.
  const completion = state.run!.completion.then(() => undefined, (error: unknown) => error).then(async (failure) => {
    state.finishing = true;
    clearTimeout(state.idleTimer);
    state.control.close();
    try { await hooks.lease.release(); } catch (error) { failure = error; }
    if (failure) state.completionError = failure instanceof Error ? failure : new Error('CLI 运行失败');
    await state.flushes;
    const aborted = state.abort.signal.aborted;
    const message = failure instanceof Error ? failure.message : failure ? 'CLI 运行失败' : '';
    if (state.turnActive) {
      state.turnActive = false;
      const status = aborted && !hooks.lease.failed ? 'interrupted' : failure ? 'error' : 'completed';
      if (!aborted && !isClientDirect(state.context)) await hooks.callbacks.flushWorkspace(sessionId).catch(() => undefined);
      await hooks.callbacks.updateSession(sessionId, { status });
      if (failure && (!aborted || hooks.lease.failed)) hooks.emitError(state, message);
      services.event('turn-state', { status });
      services.event('done', { stopped: aborted, failed: status === 'error' });
    } else if (hooks.lease.failed) {
      await hooks.callbacks.updateSession(sessionId, { status: 'error' });
      services.event('error', { message });
    }
  }).finally(() => {
    if (!state.abort.signal.aborted || hooks.isClosing()) {
      rescueUnconsumedSteers(state, state.queue);
      if (state.queue.length) hooks.retainQueue(sessionId, state.queue);
    } else state.pendingSteers = [];
    state.abort.abort();
    state.queue = [];
    hooks.clearActive(sessionId, state);
    hooks.publish(state);
  });
  void completion.catch(() => undefined);
  return completion;
}

/** Cleans up a run that failed before its completion watcher was attached, then rethrows the resulting error. */
export async function handleStartupFailure(state: ActiveRun, error: unknown, hooks: RunTeardownHooks): Promise<never> {
  const sessionId = state.context.session.id;
  const interrupted = state.abort.signal.aborted;
  state.abort.abort();
  state.control.close();
  state.run?.stop();
  await state.run?.completion.catch(() => undefined);
  let failure = error;
  try { await hooks.lease.release(); } catch (releaseError) { failure = releaseError; }
  if (!interrupted || hooks.isClosing()) {
    rescueUnconsumedSteers(state, state.queue);
    hooks.retainQueue(sessionId, state.queue);
  } else state.pendingSteers = [];
  hooks.clearActive(sessionId, state);
  const status = interrupted && !hooks.lease.failed ? 'interrupted' : 'error';
  await hooks.callbacks.updateSession(sessionId, { status });
  if (status === 'error') hooks.emitError(state, failure instanceof Error ? failure.message : String(failure ?? 'CLI 启动失败'));
  hooks.callbacks.event({ type: 'turn-state', sessionId, payload: { turnId: state.context.session.turn_id, status } });
  hooks.publish(state);
  if (interrupted && !hooks.lease.failed) throw new DOMException('会话已停止', 'AbortError');
  throw failure;
}
