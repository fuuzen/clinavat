import { agentEnvironment, agentScope, observeProcessClose, terminateProcess } from './environment.js';
import { RpcClient, type RpcMessage } from './rpc.js';
import type { AgentConfig, AgentContext } from './types.js';

export interface CodexGoal {
  threadId: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexGoalChange {
  action: 'pause' | 'resume' | 'edit';
  objective?: string;
}

export function codexServerArguments(context: AgentContext): string[] {
  return [
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'features.shell_tool=true', '-c', 'features.unified_exec=true', '-c', 'features.goals=true',
    '-c', 'features.shell_snapshot=false', '-c', 'features.multi_agent=false',
    '-c', 'web_search="disabled"',
    '-c', `projects.${JSON.stringify(context.project.local_path)}.trust_level="untrusted"`,
    'app-server',
  ];
}

export async function initializeCodexServer(rpc: RpcClient): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: 'clinavat', title: 'Clinavat', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  }, 30000, false);
  rpc.send({ method: 'initialized', params: {} });
}

function nativeGoal(value: unknown, threadId: string): CodexGoal | null {
  if (value === null || value === undefined) return null;
  const goal = value as Partial<CodexGoal>;
  if (goal.threadId !== threadId || typeof goal.objective !== 'string'
    || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(String(goal.status))) {
    throw new Error('Codex 返回了无效的目标状态，请确认 CLI 协议版本');
  }
  return goal as CodexGoal;
}

export function createCodexGoalController(rpc: RpcClient, threadId: () => string, changed: (goal: CodexGoal | null) => void) {
  let current: CodexGoal | null = null;
  let published = false;
  const publish = (value: unknown) => {
    const next = nativeGoal(value, threadId());
    const unchanged = published && JSON.stringify(current) === JSON.stringify(next);
    current = next;
    published = true;
    if (!unchanged) changed(current);
    return current;
  };
  const get = async () => {
    const result = await rpc.request('thread/goal/get', { threadId: threadId() }, 30000, false);
    return publish(result?.goal);
  };
  const set = async (input: CodexGoalChange) => {
    if (input.action === 'edit' && !input.objective?.trim()) throw new Error('目标内容不能为空');
    if (!await get()) throw new Error('当前尚未设置 Goal，请先创建目标');
    const result = await rpc.request('thread/goal/set', {
      threadId: threadId(), origin: 'user',
      ...(input.action === 'edit' ? { objective: input.objective!.trim() }
        : { status: input.action === 'pause' ? 'paused' : 'active' }),
    }, 30000, false);
    return publish(result?.goal);
  };
  return {
    get,
    set,
    async create(objective: string) {
      if (!objective.trim()) throw new Error('目标内容不能为空');
      if (await get()) {
        await rpc.request('thread/goal/clear', { threadId: threadId(), origin: 'user' }, 30000, false);
        publish(null);
      }
      const result = await rpc.request('thread/goal/set', {
        threadId: threadId(), origin: 'user', objective: objective.trim(), status: 'active',
      }, 30000, false);
      return publish(result?.goal);
    },
    observe(message: RpcMessage): boolean {
      if (message.params?.threadId !== threadId()) return false;
      if (message.method === 'thread/goal/updated') { publish(message.params.goal); return true; }
      if (message.method === 'thread/goal/cleared') { publish(null); return true; }
      return false;
    },
  };
}

// Goal metadata RPCs operate on saved threads without loading an execution session.
export async function accessCodexGoal(
  config: AgentConfig,
  context: AgentContext,
  change?: { action: 'pause' | 'edit'; objective?: string },
  signal?: AbortSignal,
): Promise<CodexGoal | null> {
  const threadId = context.session.native_session_id;
  if (!threadId) {
    if (change) throw new Error('当前对话尚未创建原生目标');
    return null;
  }
  const { execution } = config;
  const binary = await execution.resolveBinary(context.user.id, execution.binaries.codex);
  const arguments_ = codexServerArguments(context);
  if (signal?.aborted) throw new Error('目标操作已取消');
  const child = await execution.spawn(binary, arguments_, {
    scope: agentScope(context), cwd: context.project.local_path, env: agentEnvironment(execution, context),
  });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  const rpc = new RpcClient(child, async message => {
    if (message.id !== undefined && message.method) rpc.send({ id: message.id,
      error: { code: -32601, message: '目标编辑连接不执行交互或工具调用' } });
  }, () => undefined);
  const abort = () => { rpc.close(new Error('目标操作已取消')); terminateProcess(child); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await initializeCodexServer(rpc);
    const goal = createCodexGoalController(rpc, () => threadId, () => undefined);
    return change ? await goal.set(change) : await goal.get();
  } finally {
    signal?.removeEventListener('abort', abort);
    rpc.close();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}
