import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startClaude } from './claude.js';
import { startCodex } from './codex.js';
import type { AgentCallbacks, AgentConfig, AgentContext, AgentRun, ApprovalDecision, RunServices } from './types.js';

interface ActiveRun {
  projectId: string;
  abort: AbortController;
  startup: Promise<void>;
  run?: AgentRun;
  completion?: Promise<void>;
}

export class AgentManager {
  private active = new Map<string, ActiveRun>();
  private projects = new Set<string>();
  private closing = false;

  constructor(private config: AgentConfig, private callbacks: AgentCallbacks) {}

  isBusy(sessionId: string): boolean { return this.active.has(sessionId); }
  isProjectBusy(projectId: string): boolean { return this.projects.has(projectId); }

  async start(context: AgentContext, prompt: string): Promise<void> {
    if (this.closing) throw new Error('服务正在关闭');
    if (!prompt.trim()) throw new Error('消息不能为空');
    if (!context.slot.cli_types.includes(context.session.engine)) throw new Error('专属账号槽位未启用此引擎');
    if (this.active.has(context.session.id)) throw new Error('当前会话正在运行');
    if (this.projects.has(context.project.id)) throw new Error('当前项目已有运行中的会话，请先等待或停止');
    let startupDone!: () => void;
    const startup = new Promise<void>((resolve) => { startupDone = resolve; });
    const state: ActiveRun = { projectId: context.project.id, abort: new AbortController(), startup };
    this.active.set(context.session.id, state);
    this.projects.add(context.project.id);
    let expectedShellHash: string;
    try {
      await mkdir(context.slot.home_dir, { recursive: true, mode: 0o700 });
      await mkdir(path.join(context.slot.home_dir, context.session.engine === 'codex' ? '.codex' : '.claude'), {
        recursive: true, mode: 0o700,
      });
      expectedShellHash = await this.shellHash(context);
      const services: RunServices = {
        config: this.config,
        context,
        event: (type, payload) => this.callbacks.event({ type, sessionId: context.session.id,
          payload: payload && typeof payload === 'object' ? { ...payload, turnId: context.session.turn_id } : payload }),
        output: async (content) => {
          await this.callbacks.saveMessage(context.session.id, 'assistant', content);
        },
        update: async (fields) => { await this.callbacks.updateSession(context.session.id, fields); },
        approve: (tool, input) => this.awaitApproval(context.session.id, tool, input, state.abort.signal),
        verifyShell: async () => {
          if (state.abort.signal.aborted) throw new Error('会话已停止');
          if (await this.shellHash(context) !== expectedShellHash) throw new Error('远程执行脚本已被修改，请重新创建项目以恢复');
        },
      };
      await this.callbacks.updateSession(context.session.id, { status: 'running' });
      state.run = context.session.engine === 'claude'
        ? await startClaude(services, prompt)
        : await startCodex(services, prompt, state.abort.signal);
      if (state.abort.signal.aborted) state.run.stop();
      state.completion = state.run.completion.then(async () => {
        await this.callbacks.updateSession(context.session.id, { status: state.abort.signal.aborted ? 'interrupted' : 'completed' });
        services.event('turn-state', { status: state.abort.signal.aborted ? 'interrupted' : 'completed' });
        services.event('done', { stopped: state.abort.signal.aborted });
      }).catch(async (error: unknown) => {
        await this.callbacks.updateSession(context.session.id, { status: state.abort.signal.aborted ? 'interrupted' : 'error' });
        services.event('turn-state', { status: state.abort.signal.aborted ? 'interrupted' : 'error' });
        if (!state.abort.signal.aborted) services.event('error', { message: error instanceof Error ? error.message : 'CLI 运行失败' });
        services.event('done', { stopped: state.abort.signal.aborted, failed: !state.abort.signal.aborted });
      }).finally(() => {
        state.abort.abort();
        this.active.delete(context.session.id);
        this.projects.delete(context.project.id);
      });
      void state.completion.catch(() => undefined);
    } catch (error) {
      const interrupted = state.abort.signal.aborted;
      state.abort.abort();
      state.run?.stop();
      this.active.delete(context.session.id);
      this.projects.delete(context.project.id);
      await this.callbacks.updateSession(context.session.id, { status: interrupted ? 'interrupted' : 'error' });
      this.callbacks.event({ type: 'turn-state', sessionId: context.session.id,
        payload: { turnId: context.session.turn_id, status: interrupted ? 'interrupted' : 'error' } });
      throw error;
    } finally {
      startupDone();
    }
  }

  stop(sessionId: string): void {
    const state = this.active.get(sessionId);
    if (!state) return;
    state.abort.abort();
    state.run?.stop();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const sessionId of this.active.keys()) this.stop(sessionId);
    await Promise.allSettled([...this.active.values()].map((state) => state.startup));
    await Promise.allSettled([...this.active.values()].flatMap((state) => state.completion ? [state.completion] : []));
  }

  private async shellHash(context: AgentContext): Promise<string> {
    const script = path.join(context.project.local_path, '.bin', 'remote-shell');
    try { return createHash('sha256').update(await readFile(script)).digest('hex'); }
    catch { throw new Error('项目远程执行器尚未准备好，请先重新同步项目'); }
  }

  private awaitApproval(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny', reason: '会话已停止' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(decision);
      };
      const abort = () => finish({ decision: 'deny', reason: '会话已停止' });
      const timer = setTimeout(() => finish({ decision: 'deny', reason: '审批超时，已自动拒绝' }), this.config.approvalTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      void this.callbacks.approval({ sessionId, tool, input }).then(finish)
        .catch(() => finish({ decision: 'deny', reason: '审批服务不可用，已拒绝' }));
    });
  }
}
