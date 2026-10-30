import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { startClaude } from './claude.js';
import { startCodex } from './codex.js';
import { getPermissionMode } from './permissions.js';
import { UserInputRequests } from './user-input.js';
import { RunControl } from './run-control.js';
import { HttpError } from '../models.js';
import type { AgentCallbacks, AgentConfig, AgentContext, AgentRun, ApprovalDecision, RunServices } from './types.js';
import type { CodexGoal, CodexGoalChange } from './codex-goal.js';

interface ActiveRun {
  userId: string;
  projectId: string;
  abort: AbortController;
  startup: Promise<void>;
  control: RunControl;
  finishing?: boolean;
  run?: AgentRun;
  completion?: Promise<void>;
  credentialError?: Error;
  verifyShell?: () => Promise<void>;
}

export class AgentManager {
  private active = new Map<string, ActiveRun>();
  private closing = false;
  readonly questions: UserInputRequests;

  constructor(private config: AgentConfig, private callbacks: AgentCallbacks) {
    this.questions = new UserInputRequests(callbacks.event);
  }

  isBusy(sessionId: string): boolean { return this.active.has(sessionId); }
  isProjectBusy(projectId: string): boolean { return [...this.active.values()].some(state => state.projectId === projectId); }
  isUserBusy(userId: string): boolean { return [...this.active.values()].some(state => state.userId === userId); }

  async start(context: AgentContext, prompt: string): Promise<void> {
    if (this.closing) throw new Error('服务正在关闭');
    const nativeResume = context.session.engine === 'codex' && context.session.goal
      || context.session.engine === 'claude' && context.session.resume_interrupted && context.session.native_session_id;
    if (!prompt.trim() && !nativeResume) throw new Error('消息不能为空');
    if (context.slot.engine !== context.session.engine) throw new Error('当前账号槽位未启用此引擎');
    if (this.active.has(context.session.id)) throw new Error('当前会话正在运行');
    let startupDone!: () => void;
    const startup = new Promise<void>((resolve) => { startupDone = resolve; });
    const state: ActiveRun = { userId: context.user.id, projectId: context.project.id, abort: new AbortController(), startup, control: new RunControl() };
    this.active.set(context.session.id, state);
    state.control.subscribe(status => {
      if (state.finishing || state.abort.signal.aborted || this.active.get(context.session.id) !== state) return;
      void this.callbacks.updateSession(context.session.id, { status });
      this.callbacks.event({ type: 'turn-state', sessionId: context.session.id,
        payload: { turnId: context.session.turn_id, status } });
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
        event: (type, payload) => this.callbacks.event({ type, sessionId: context.session.id,
          payload: payload && typeof payload === 'object' ? { ...payload, turnId: context.session.turn_id } : payload }),
        output: async (content) => {
          await this.callbacks.saveMessage(context.session.id, 'assistant', content);
        },
        update: async (fields) => { await this.callbacks.updateSession(context.session.id, fields); },
        approve: async (tool, input, requestSignal) => {
          const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
          if (signal.aborted) return { decision: 'deny', reason: '审批已取消' };
          await state.control.waitUntilRunning(signal);
          const decision: ApprovalDecision = getPermissionMode(context.session) === 'yolo' && context.session.agent_mode !== 'plan'
            ? { decision: 'allow', reason: 'YOLO：本系统自动批准' }
            : await this.awaitApproval(context.session.id, tool, input, signal, state.control);
          await state.control.waitUntilRunning(signal);
          return decision;
        },
        ask: async (questions, requestSignal) => {
          const signal = requestSignal ? AbortSignal.any([state.abort.signal, requestSignal]) : state.abort.signal;
          await state.control.waitUntilRunning(signal);
          const answers = await this.questions.request(context.session.id, questions, signal);
          await state.control.waitUntilRunning(signal);
          return answers;
        },
        verifyShell: async () => {
          await state.control.waitUntilRunning(state.abort.signal);
          await state.verifyShell!();
          await state.control.waitUntilRunning(state.abort.signal);
        },
      };
      await this.callbacks.updateSession(context.session.id, { status: 'running' });
      state.run = context.session.engine === 'claude'
        ? await startClaude(services, prompt, state.abort.signal)
        : await startCodex(services, prompt, state.abort.signal);
      if (state.abort.signal.aborted) state.run.stop();
      state.completion = state.run.completion.finally(() => {
        state.finishing = true;
        state.control.close();
        return releaseCredentials();
      }).then(async () => {
        if (!state.abort.signal.aborted) await this.callbacks.flushWorkspace(context.session.id);
        await this.callbacks.updateSession(context.session.id, { status: state.abort.signal.aborted ? 'interrupted' : 'completed' });
        services.event('turn-state', { status: state.abort.signal.aborted ? 'interrupted' : 'completed' });
        services.event('done', { stopped: state.abort.signal.aborted });
      }).catch(async (error: unknown) => {
        const status = state.abort.signal.aborted && !credentialFailure ? 'interrupted' : 'error';
        await this.callbacks.updateSession(context.session.id, { status });
        services.event('turn-state', { status });
        if (!state.abort.signal.aborted || credentialFailure) services.event('error', { message: error instanceof Error ? error.message : 'CLI 运行失败' });
        services.event('done', { stopped: state.abort.signal.aborted, failed: !state.abort.signal.aborted || credentialFailure });
      }).finally(() => {
        state.abort.abort();
        this.active.delete(context.session.id);
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
      this.active.delete(context.session.id);
      const status = interrupted && !credentialFailure ? 'interrupted' : 'error';
      await this.callbacks.updateSession(context.session.id, { status });
      this.callbacks.event({ type: 'turn-state', sessionId: context.session.id,
        payload: { turnId: context.session.turn_id, status } });
      throw failure;
    } finally {
      startupDone();
    }
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state) return;
    state.abort.abort();
    state.control.close();
    state.run?.stop();
    await state.startup;
    await state.completion;
    if (state.credentialError) throw state.credentialError;
  }

  pause(sessionId: string): string {
    const state = this.controllableRun(sessionId);
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
    const script = path.join(context.project.local_path, '.bin', 'remote-shell');
    try { return createHash('sha256').update(await readFile(script)).digest('hex'); }
    catch { throw new Error('项目远程执行器尚未准备好，请先重新同步项目'); }
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
