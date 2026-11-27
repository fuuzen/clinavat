import { agentEnvironment, agentScope, observeProcessClose, terminateProcess, vmProjectRoot, vmWorkingDirectory } from '../environment.js';
import { initializeCodexServer } from '../codex/goal.js';
import { RpcClient, type RpcMessage } from '../rpc.js';
import { BTW_SYSTEM_PROMPT, buildBtwUserPrompt } from './context.js';
import type { BtwEngineInput } from './types.js';

const CODEX_BTW_TIMEOUT_MS = 120_000;
const BTW_DENY_TOOL_MESSAGE = '旁路提问（/btw）模式禁用所有工具调用，请仅基于已有上下文直接回答。';
const BTW_THREAD_CONFIG = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.multi_agent': false,
  'features.goals': false,
};

interface ActiveCodexBtw {
  turnId: string;
  streamed: string;
  finalText: string;
  errorMessage: string;
  onDelta?: (chunk: string) => void;
  resolve(answer: string): void;
  reject(error: Error): void;
}

export interface CodexBtwAskOptions {
  rpc: RpcClient;
  mainThreadId?: string;
  root: string;
  model?: string;
  effort?: string;
  question: string;
  snapshot: string;
  signal: AbortSignal;
  onDelta?: (chunk: string) => void;
  onActivityChanged?: () => void;
}

/**
 * Routes ephemeral `/btw` threads on a Codex `app-server` connection, keeping all notifications and
 * server requests strictly isolated from the main conversation turn stream and auto-denying every tool/approval.
 */
export class CodexBtwRouter {
  private threads = new Map<string, ActiveCodexBtw>();

  constructor(private send: (message: RpcMessage) => void) {}

  busy(): boolean {
    return this.threads.size > 0;
  }

  observe(message: RpcMessage): boolean {
    const params = message.params ?? {};
    const source = String(params.threadId ?? params.thread?.id ?? '');
    if (!source) return false;
    const entry = this.threads.get(source);
    if (!entry) return false;

    if (message.id !== undefined && message.method) {
      this.denyServerRequest(message);
      return true;
    }

    if (message.method === 'turn/started') {
      entry.turnId = String(params.turn?.id ?? entry.turnId);
      return true;
    }
    if (message.method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      if (delta) {
        entry.streamed += delta;
        entry.onDelta?.(delta);
      }
      return true;
    }
    if (message.method === 'item/completed') {
      const item = params.item;
      if (item && typeof item === 'object' && item.type === 'agentMessage' && typeof item.text === 'string') {
        entry.finalText = item.text;
        if (!entry.streamed && item.text) entry.onDelta?.(item.text);
      }
      return true;
    }
    if (message.method === 'error' && params.willRetry !== true) {
      entry.errorMessage = String(params.error?.message ?? 'Codex 旁路提问失败');
      return true;
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn ?? {};
      const status = String(turn.status ?? '');
      if (status === 'failed') {
        entry.reject(new Error(String(turn.error?.message ?? entry.errorMessage) || 'Codex 旁路提问失败'));
      } else if (status === 'interrupted') {
        entry.reject(new DOMException('旁路提问已取消', 'AbortError'));
      } else {
        const answer = (entry.streamed || entry.finalText).trim();
        entry.resolve(answer);
      }
      return true;
    }
    return true;
  }

  private denyServerRequest(message: RpcMessage): void {
    const method = message.method ?? '';
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.send({ id: message.id, result: { decision: 'decline' } });
      return;
    }
    if (method === 'execCommandApproval') {
      this.send({ id: message.id, result: { decision: 'denied' } });
      return;
    }
    if (method === 'item/tool/call') {
      this.send({
        id: message.id,
        result: { contentItems: [{ type: 'inputText', text: BTW_DENY_TOOL_MESSAGE }], success: false },
      });
      return;
    }
    this.send({
      id: message.id,
      error: { code: -32601, message: BTW_DENY_TOOL_MESSAGE },
    });
  }

  async ask(options: CodexBtwAskOptions): Promise<string> {
    const { rpc, mainThreadId, root, model, effort, question, snapshot, signal, onDelta, onActivityChanged } = options;
    if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');

    const sharedThread = {
      cwd: root,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      developerInstructions: BTW_SYSTEM_PROMPT,
      ephemeral: true,
      ...(model ? { model } : {}),
      config: {
        ...BTW_THREAD_CONFIG,
        ...(effort ? { model_reasoning_effort: effort } : {}),
      },
    };

    let btwThreadId = '';
    let usedSnapshot = false;
    if (mainThreadId) {
      try {
        // `excludeTurns: true` only omits hydrating turns in the RPC response; full forked history remains on the thread.
        const forked = await rpc.request('thread/fork', {
          ...sharedThread,
          threadId: mainThreadId,
          excludeTurns: true,
        }, 30_000, false);
        btwThreadId = String(forked?.thread?.id ?? '');
      } catch {
        // Active main turn or missing thread on disk: fall back cleanly to an ephemeral thread with context snapshot.
        btwThreadId = '';
      }
    }
    if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');
    if (!btwThreadId) {
      usedSnapshot = true;
      const started = await rpc.request('thread/start', sharedThread, 30_000, false);
      btwThreadId = String(started?.thread?.id ?? '');
    }
    if (!btwThreadId) throw new Error('Codex 未返回旁路临时线程 ID');

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, answer?: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (error) reject(error);
          else resolve(answer ?? '');
        };
        const entry: ActiveCodexBtw = {
          turnId: '',
          streamed: '',
          finalText: '',
          errorMessage: '',
          onDelta,
          resolve: answer => finish(undefined, answer),
          reject: error => finish(error),
        };
        this.threads.set(btwThreadId, entry);
        onActivityChanged?.();

        onAbort = () => {
          if (entry.turnId) {
            void rpc.request('turn/interrupt', { threadId: btwThreadId, turnId: entry.turnId }, 5_000, false).catch(() => undefined);
          }
          finish(new DOMException('旁路提问已取消', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          if (entry.turnId) {
            void rpc.request('turn/interrupt', { threadId: btwThreadId, turnId: entry.turnId }, 5_000, false).catch(() => undefined);
          }
          finish(new Error('Codex 旁路提问超时'));
        }, CODEX_BTW_TIMEOUT_MS);

        const promptText = buildBtwUserPrompt(question, usedSnapshot ? snapshot : undefined);
        void rpc.request('turn/start', {
          threadId: btwThreadId,
          cwd: root,
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          input: [{ type: 'text', text: promptText }],
        }, CODEX_BTW_TIMEOUT_MS, false).then(
          result => {
            if (result?.turn?.id && !entry.turnId) entry.turnId = String(result.turn.id);
          },
          error => finish(error instanceof Error ? error : new Error('Codex 启动旁路轮次失败')),
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      this.threads.delete(btwThreadId);
      onActivityChanged?.();
    }
  }

  close(error = new Error('Codex 进程已关闭')): void {
    const entries = [...this.threads.values()];
    this.threads.clear();
    for (const entry of entries) entry.reject(error);
  }
}

/** Cold/paused Codex /btw: spawns a short-lived `codex app-server` under a `probe` lease. */
export async function runCodexBtw(input: BtwEngineInput): Promise<string> {
  const { config, context, question, snapshot, signal, onDelta } = input;
  if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');
  const scope = agentScope(context, config.workspaceDir);
  const binary = await config.execution.binary(scope, 'codex');
  const vmRoot = vmProjectRoot(context, config.workspaceDir);
  const cwd = vmWorkingDirectory(context, config.workspaceDir);
  const args = [
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'features.shell_tool=false',
    '-c', 'features.unified_exec=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.goals=false',
    '-c', 'features.shell_snapshot=false',
    '-c', `projects.${JSON.stringify(vmRoot)}.trust_level="untrusted"`,
    ...(cwd !== vmRoot ? ['-c', `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`] : []),
    'app-server',
  ];
  const child = await config.execution.spawn(binary, args, {
    scope,
    cwd,
    env: agentEnvironment(config.execution, context, scope),
  });
  const closed = observeProcessClose(child);
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });

  let rpc!: RpcClient;
  const router = new CodexBtwRouter(message => rpc.send(message));
  rpc = new RpcClient(
    child,
    async message => {
      if (router.observe(message)) return;
      if (message.id !== undefined && message.method) {
        rpc.send({ id: message.id, error: { code: -32601, message: BTW_DENY_TOOL_MESSAGE } });
      }
    },
    error => router.close(error),
  );

  const onAbort = () => {
    router.close(new DOMException('旁路提问已取消', 'AbortError'));
    terminateProcess(child);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    await initializeCodexServer(rpc);
    return await router.ask({
      rpc,
      mainThreadId: context.session.native_session_id ?? undefined,
      root: cwd,
      model: context.session.model ?? undefined,
      effort: context.session.reasoning_effort ?? undefined,
      question,
      snapshot,
      signal,
      onDelta,
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new DOMException('旁路提问已取消', 'AbortError');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail || diagnostics.trim() || 'Codex 旁路提问失败');
  } finally {
    signal.removeEventListener('abort', onAbort);
    router.close();
    rpc.close();
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    terminateProcess(child);
    await closed.catch(() => undefined);
  }
}
