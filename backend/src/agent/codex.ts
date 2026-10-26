import { spawn } from 'node:child_process';
import { agentEnvironment, findExecutable, terminateProcess } from './environment.js';
import { RpcClient, type RpcMessage } from './rpc.js';
import { dynamicTools, executeDynamicTool } from './tools.js';
import { loadAgentModels } from './model-catalog.js';
import type { AgentRun, RunServices } from './types.js';

const developerInstructions = `This project uses a split execution environment. Source files are mirrored locally; all shell commands, git, builds and tests MUST run on the remote development host via remote_command. Use workspace_read, workspace_list and workspace_search for local source inspection. Use workspace_write or workspace_replace for source edits, which receive explicit web approval. Built-in shell and file-write tools are intentionally restricted and cannot be approved. Never read or change .bin, .git, .claude, .codex or files outside this project. Do not request background or detached commands. The synchronization wrapper flushes changes before and after each remote command.`;

export async function startCodex(services: RunServices, prompt: string, signal: AbortSignal): Promise<AgentRun> {
  const binary = await findExecutable(services.config.codexBinary);
  const root = services.context.project.local_path;
  const child = spawn(binary, [
    '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
    '-c', 'features.shell_snapshot=false', '-c', 'features.multi_agent=false',
    '-c', 'web_search="disabled"', '-c', `projects.${JSON.stringify(root)}.trust_level="untrusted"`,
    'app-server',
  ], { cwd: root, env: agentEnvironment(services.context), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let threadId = '';
  let turnId = '';
  let diagnostics = '';
  let finished = false;
  let stopped = false;
  let textSize = 0;
  const messages = new Map<string, string>();
  const phases = new Map<string, string>();
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  void completion.catch(() => undefined);
  const finish = async (error?: Error) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    try {
      const explicitFinal = [...messages.keys()].filter(id => phases.get(id) === 'final_answer');
      const unclassified = [...messages.keys()].filter(id => !phases.has(id));
      const finalIds = explicitFinal.length ? explicitFinal : !error && !stopped ? unclassified.slice(-1) : [];
      for (const id of finalIds) services.event('activity', { id, kind: 'text', text: messages.get(id) || '', final: true });
      const text = finalIds.map(id => messages.get(id)).join('\n\n');
      if (text.trim()) await services.output(text.trim());
      if (error && !stopped) rejectCompletion(error);
      else resolveCompletion();
    } catch (failure) { rejectCompletion(failure instanceof Error ? failure : new Error('会话持久化失败')); }
    finally {
      rpc.close();
      child.stdin.end();
      terminateProcess(child);
    }
  };
  const onMessage = async (message: RpcMessage) => {
    const params = message.params ?? {};
    if (message.id !== undefined && message.method) {
      if (message.method === 'item/tool/call') {
        let input: Record<string, unknown> = {};
        const name = String(params.tool ?? '');
        try {
          input = typeof params.arguments === 'string' ? JSON.parse(params.arguments) : params.arguments;
          if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('工具参数无效');
          const toolServices: RunServices = { ...services, event(type, payload) {
            services.event(type, type === 'tool' && payload && typeof payload === 'object'
              ? { ...payload, id: params.callId } : payload);
          } };
          const output = await executeDynamicTool(toolServices, name, input, signal);
          rpc.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: output }], success: true } });
          services.event('tool', { id: params.callId, tool: name, status: 'completed', output: output.slice(0, 128 * 1024) });
        } catch (error) {
          const text = error instanceof Error ? error.message : '工具执行失败';
          rpc.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text }], success: false } });
          services.event('tool', { id: params.callId, tool: name, status: 'failed', output: text });
        }
        return;
      }
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval'].includes(message.method)) {
        rpc.send({ id: message.id, result: { decision: 'decline' } });
        services.event('tool', { id: params.itemId, tool: 'native_tool', status: 'declined',
          output: '原生本地命令与文件变更已禁用，请使用工作台的远程命令与工作区工具。' });
        return;
      }
      rpc.send({ id: message.id, error: { code: -32601, message: '当前工作台不支持此交互请求，请通过对话向用户说明。' } });
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const text = String(params.delta ?? '');
      if (textSize + text.length > 8 * 1024 * 1024) {
        await finish(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
      }
      const id = String(params.itemId ?? 'partial');
      messages.set(id, (messages.get(id) ?? '') + text);
      textSize += text.length;
      services.event('activity', { id, kind: 'text', text, append: true });
    }
    if (message.method === 'item/reasoning/summaryTextDelta') {
      services.event('activity', {
        id: `${params.itemId}:summary:${params.summaryIndex ?? 0}`, kind: 'reasoning',
        text: String(params.delta ?? ''), append: true,
      });
    }
    if (message.method === 'item/started') {
      const item = params.item;
      if (item?.type === 'dynamicToolCall') services.event('tool', { id: item.id, tool: item.tool, input: item.arguments, status: 'running' });
      if (item?.type === 'agentMessage' && typeof item.phase === 'string') phases.set(String(item.id), item.phase);
      if (item && ['webSearch', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) {
        services.event('tool', { id: item.id, tool: item.type, input: item.command ?? item.action ?? item.arguments ?? item.changes, status: 'running' });
      }
    }
    if (message.method === 'item/completed') {
      const item = params.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        const id = String(item.id);
        textSize += item.text.length - (messages.get(id)?.length ?? 0);
        if (textSize > 8 * 1024 * 1024) {
          await finish(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
        }
        messages.set(id, item.text);
        if (typeof item.phase === 'string') phases.set(id, item.phase);
        services.event('activity', { id, kind: 'text', text: item.text });
      }
      if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
        item.summary.forEach((text: unknown, index: number) => {
          if (typeof text === 'string') services.event('activity', { id: `${item.id}:summary:${index}`, kind: 'reasoning', text });
        });
      }
      if (item && ['webSearch', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) {
        services.event('tool', { id: item.id, tool: item.type, input: item.command ?? item.action ?? item.arguments ?? item.changes,
          output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 128 * 1024) : undefined,
          status: item.status === 'failed' || item.exitCode > 0 ? 'failed' : 'completed' });
      }
    }
    if (message.method === 'turn/diff/updated') services.event('tool', { id: 'turn-diff', tool: 'diff', output: params.diff, status: 'completed' });
    if (message.method === 'turn/started') turnId = String(params.turn?.id ?? turnId);
    if (message.method === 'error') {
      services.event('error', { message: String(params.error?.message ?? 'Codex 运行错误') });
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn ?? {};
      await finish(turn.status === 'failed' ? new Error(String(turn.error?.message ?? 'Codex 会话失败')) : undefined);
    }
  };
  const rpc = new RpcClient(child, onMessage, (error) => { void finish(error); });
  const abort = () => {
    stopped = true;
    if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => undefined);
    terminateProcess(child);
  };
  signal.addEventListener('abort', abort, { once: true });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-16 * 1024); });
  child.once('error', (error) => { void finish(error); });
  child.once('close', (code, exitSignal) => {
    if (!finished) void finish(stopped ? undefined : new Error(diagnostics.trim() || `Codex app-server 已退出（${code ?? exitSignal}）`));
  });
  try {
    if (signal.aborted) { abort(); throw new Error('会话已停止'); }
    await rpc.request('initialize', { clientInfo: { name: 'cc_pool', title: 'CC Pool', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    const selection = services.context.session;
    const models = await loadAgentModels(services.config, services.context);
    const model = selection.model || models.find(item => item.isDefault)?.id;
    const effort = selection.reasoning_effort || models.find(item => item.id === model)?.defaultReasoningEffort;
    const shared = { cwd: root, sandbox: 'read-only', approvalPolicy: 'on-request', developerInstructions,
      ...(model ? { model } : {}),
      config: { 'features.shell_tool': false, 'features.unified_exec': false, 'features.multi_agent': false,
        ...(effort ? { model_reasoning_effort: effort } : {}) } };
    const nativeId = services.context.session.native_session_id;
    const result = nativeId
      ? await rpc.request('thread/resume', { ...shared, threadId: nativeId, excludeTurns: true })
      : await rpc.request('thread/start', { ...shared, dynamicTools });
    if (!result?.thread?.id) throw new Error('Codex 未返回线程 ID，请确认固定版本的 app-server 协议');
    threadId = String(result.thread.id);
    if (signal.aborted) throw new Error('会话已停止');
    const turn = await rpc.request('turn/start', {
      threadId, input: [{ type: 'text', text: prompt }], cwd: root,
      approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    turnId = String(turn?.turn?.id ?? turnId);
    await services.update({ native_session_id: threadId,
      ...(typeof result.thread.path === 'string' ? { jsonl_file_path: result.thread.path } : {}) });
  } catch (error) {
    terminateProcess(child);
    rpc.close();
    signal.removeEventListener('abort', abort);
    throw new Error(`Codex 启动失败：${error instanceof Error ? error.message : '协议不兼容'}`);
  }
  return { process: child, completion, stop: abort };
}
