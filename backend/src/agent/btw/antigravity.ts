import { agentEnvironment, agentScope, observeProcessClose, terminateProcess, vmWorkingDirectory } from '../environment.js';
import { prepareAntigravityHome } from '../antigravity/setup.js';
import { RpcClient, type RpcMessage } from '../rpc.js';
import { BTW_SYSTEM_PROMPT, buildBtwUserPrompt } from './context.js';
import type { BtwEngineInput } from './types.js';

const AGY_BTW_TIMEOUT_MS = 120_000;

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: unknown;
  options?: { value?: unknown }[];
}

/**
 * Runs a read-only Antigravity `/btw` side question in a lightweight standalone `agy acp` process
 * with `CLINAVAT_AGY_BTW=1` (activating the `btw-gate` PreToolUse hard-deny hook) and zero MCP servers.
 */
export async function runAntigravityBtw(input: BtwEngineInput): Promise<string> {
  const { config, context, question, snapshot, signal, onDelta } = input;
  if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');

  const scope = agentScope(context, config.workspaceDir);
  const vmCwd = vmWorkingDirectory(context, config.workspaceDir);
  const binary = await config.execution.binary(scope, 'agy');
  const home = await prepareAntigravityHome(context, config.workspaceDir);
  if (signal.aborted) {
    await home.close().catch(() => undefined);
    throw new DOMException('旁路提问已取消', 'AbortError');
  }

  let child;
  try {
    child = await config.execution.spawn(binary, ['acp', '--disable-telemetry'], {
      scope,
      cwd: vmCwd,
      env: {
        ...agentEnvironment(config.execution, context, scope),
        ...home.hookEnvironment,
        CLINAVAT_AGY_BTW: '1',
      },
    });
  } catch (error) {
    await home.close().catch(() => undefined);
    throw error;
  }

  const closed = observeProcessClose(child);
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });

  let acpSessionId = '';
  let answer = '';
  let rpc!: RpcClient;

  const denyRequest = (message: RpcMessage) => {
    const params = message.params ?? {};
    if (message.method === 'session/request_permission') {
      const options: { optionId?: string; kind?: string }[] = Array.isArray(params.options) ? params.options : [];
      const rejectOption = options.find(option => option.kind === 'reject_once')?.optionId;
      rpc.send({
        id: message.id,
        result: { outcome: rejectOption ? { outcome: 'selected', optionId: rejectOption } : { outcome: 'cancelled' } },
      });
      return;
    }
    if (message.method === 'elicitation/create') {
      rpc.send({ id: message.id, result: { action: 'decline' } });
      return;
    }
    rpc.send({ id: message.id, error: { code: -32601, message: '旁路提问模式不支持交互请求' } });
  };

  rpc = new RpcClient(
    child,
    async message => {
      if (message.id !== undefined && message.method) {
        denyRequest(message);
        return;
      }
      if (message.method === 'session/update' && message.params?.sessionId === acpSessionId) {
        const update = message.params.update ?? {};
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          const chunk = String(update.content.text ?? '');
          if (chunk) {
            answer += chunk;
            onDelta(chunk);
          }
        }
      }
    },
    () => undefined,
    undefined,
    { name: 'Antigravity BTW', connection: 'Antigravity BTW ACP', jsonrpc: true },
  );

  const onAbort = () => {
    if (acpSessionId) rpc.send({ method: 'session/cancel', params: { sessionId: acpSessionId } });
    rpc.close(new DOMException('旁路提问已取消', 'AbortError'));
    terminateProcess(child);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'clinavat-btw', title: 'Clinavat BTW', version: '0.1.0' },
    }, 30_000);
    if (initialized?.protocolVersion !== 1) throw new Error('ACP 协议版本不兼容');

    const session = await rpc.request('session/new', {
      cwd: vmCwd,
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: BTW_SYSTEM_PROMPT } } },
    }, 60_000);
    acpSessionId = String(session?.sessionId ?? '');
    if (!acpSessionId) throw new Error('Antigravity 旁路会话未返回 ID');

    let options: ConfigOption[] = Array.isArray(session?.configOptions) ? session.configOptions : [];
    const tryChoose = async (category: string, value: string | null | undefined) => {
      if (!value) return;
      const option = options.find(item => item.category === category);
      if (!option || option.currentValue === value || !option.options?.some(item => item.value === value)) return;
      const changed = await rpc.request('session/set_config_option', {
        sessionId: acpSessionId,
        configId: option.id,
        value,
      }, 20_000).catch(() => undefined);
      if (Array.isArray(changed?.configOptions)) options = changed.configOptions;
    };
    await tryChoose('model', context.session.model);
    await tryChoose('thought_level', context.session.reasoning_effort);

    const result = await rpc.request('session/prompt', {
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: buildBtwUserPrompt(question, snapshot) }],
    }, AGY_BTW_TIMEOUT_MS);

    if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');
    const reason = result?.stopReason;
    if (reason === 'cancelled') throw new DOMException('旁路提问已取消', 'AbortError');
    if (reason && reason !== 'end_turn') {
      throw new Error(reason === 'refusal' ? '模型拒绝了这次旁路提问' : `Antigravity 旁路提问提前结束（${String(reason)}）`);
    }
    return answer.trim();
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new DOMException('旁路提问已取消', 'AbortError');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail || diagnostics.trim() || 'Antigravity 旁路提问失败');
  } finally {
    signal.removeEventListener('abort', onAbort);
    rpc.close();
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    terminateProcess(child);
    await closed.catch(() => undefined);
    await home.close().catch(() => undefined);
  }
}
