import { randomUUID } from 'node:crypto';
import { openContained } from '../../runtime/contained-files.js';
import { antigravityProbe } from '../../accounts/usage-probes.js';
import { antigravityUsage } from '../../token-usage/meters.js';
import { agentEnvironment, agentScope, observeProcessClose, terminateProcess } from '../environment.js';
import { getPermissionMode } from '../permissions.js';
import { conversationInstructions } from '../project-instructions.js';
import { assertWritable, orchestrates, workingDirectory } from '../orchestration-tools.js';
import { isHubToolCall, startToolBridge } from './tool-bridge.js';
import { RpcClient, type RpcMessage } from '../rpc.js';
import type { AgentPrompt, AgentRun, RunServices, TurnOutcome } from '../types.js';
import { prepareAntigravityHome, rewrittenCommandNotice } from './setup.js';
import { describeToolCall, formContent, formQuestions, toolOutput, toolStatus, type AcpToolCall } from './updates.js';

// How long a CLI told to finish may take before it is stopped.
const EXIT_GRACE_MS = 10_000;
// A prompt lasts as long as its turn; the RunControl timer leaves out paused time.
const PROMPT_TIMEOUT_MS = 7 * 24 * 3_600_000;
const TEXT_LIMIT = 8 * 1024 * 1024;

interface ConfigOption { id: string; category?: string; currentValue?: unknown; options?: { value?: unknown }[] }

export async function startAntigravity(services: RunServices, prompt: AgentPrompt, signal: AbortSignal): Promise<AgentRun> {
  if (signal.aborted) throw new Error('会话已停止');
  const { execution } = services.config;
  const { context } = services;
  const scope = agentScope(context);
  const binary = await execution.binary(scope, 'agy');
  const home = await prepareAntigravityHome(context);
  if (signal.aborted) throw new Error('会话已停止');
  // A master's tools reach agy as a stdio MCP server, through a bridge back to the Hub.
  const tools = orchestrates(context) ? await startToolBridge(services, home.toolShim, signal) : undefined;
  const child = await execution.spawn(binary, ['acp', '--disable-telemetry'], {
    scope, cwd: workingDirectory(context), env: agentEnvironment(execution, context, scope),
  }).catch((error: unknown) => { tools?.close(); throw error; });
  services.control.track(child);
  const closed = observeProcessClose(child);
  void closed.then(() => tools?.close());
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16 * 1024); });

  let sessionId = '';
  let model = context.session.model || 'unknown';
  let turnActive = true;
  // Prompts still awaiting their response: a prompt sent while a turn runs steers it and takes over its response.
  let prompts = 0;
  let interruptRequested = false;
  let failure = '';
  // The turn began without a prompt, when agy resumed after a background command; its end comes from the Stop hook.
  let autonomous = false;
  let fullyIdle = true;
  let closing = false;
  let stopped = false;
  let exitGrace: NodeJS.Timeout | undefined;
  let turnAbort = new AbortController();
  const runningCommands = new Set<string>();
  // Text and thinking are split at every tool call; the reply is the text after the last one.
  let turnKey = randomUUID();
  let segment = 0;
  let segmentOpen = false;
  let thinking = 0;
  let thinkingOpen = false;
  let textSize = 0;
  const texts = new Map<string, string>();
  let lastTextId: string | undefined;

  const fail = (error: Error) => { failure ||= error.message; terminateProcess(child); };
  const endTurn = (outcome: TurnOutcome['status'], error?: string) => {
    if (!turnActive) return;
    turnActive = false;
    autonomous = false;
    interruptRequested = false;
    turnAbort.abort();
    const output = lastTextId ? texts.get(lastTextId)?.trim() ?? '' : '';
    if (lastTextId && output) services.event('activity', { id: lastTextId, kind: 'text', text: texts.get(lastTextId), final: true });
    texts.clear();
    lastTextId = undefined;
    textSize = 0;
    services.turnEnded(outcome === 'error' ? { status: 'error', error: error || 'Antigravity 运行失败', output } : { status: outcome, output });
    services.activityChanged();
  };
  const beginTurn = () => {
    turnActive = true;
    turnAbort = new AbortController();
    turnKey = randomUUID();
    segment = thinking = 0;
    segmentOpen = thinkingOpen = false;
  };

  const append = (kind: 'text' | 'reasoning', text: string) => {
    if (textSize + text.length > TEXT_LIMIT) { fail(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return; }
    textSize += text.length;
    if (kind === 'text') {
      if (!segmentOpen) { segment++; segmentOpen = true; }
      const id = `${turnKey}:text:${segment}`;
      texts.set(id, (texts.get(id) ?? '') + text);
      lastTextId = id;
      services.event('activity', { id, kind: 'text', text, append: true });
    } else {
      if (!thinkingOpen) { thinking++; thinkingOpen = true; }
      services.event('activity', { id: `${turnKey}:thinking:${thinking}`, kind: 'reasoning', text, append: true });
    }
  };

  const onTool = (call: AcpToolCall) => {
    if (!call.toolCallId) return;
    segmentOpen = thinkingOpen = false;
    const status = toolStatus(call.status);
    if (call.name === 'run_command') {
      if (status === 'running') runningCommands.add(call.toolCallId);
      else if (runningCommands.delete(call.toolCallId)) services.activityChanged();
    }
    const output = toolOutput(call);
    // Every command must have gone through the routing hook; one that did not ran in the slot's machine instead.
    if (home.shell && call.name === 'run_command' && call.status === 'completed' && output !== undefined
      && !output.startsWith(rewrittenCommandNotice)) {
      fail(new Error('命令未经过开发机路由，已停止会话'));
      return;
    }
    const { tool, input } = describeToolCall(call);
    services.event('tool', { id: call.toolCallId, tool, input, status, ...(output !== undefined ? { output } : {}) });
  };

  const onUpdate = (update: Record<string, any>) => {
    const kind = update?.sessionUpdate;
    const content = ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(kind);
    if (content && !turnActive && !closing && !stopped) {
      beginTurn();
      autonomous = true;
      services.automaticTurn({ summary: 'Antigravity 在后台任务结束后继续执行' });
    }
    if (kind === 'agent_message_chunk' && update.content?.type === 'text') append('text', String(update.content.text ?? ''));
    else if (kind === 'agent_thought_chunk' && update.content?.type === 'text') append('reasoning', String(update.content.text ?? ''));
    else if (kind === 'tool_call' || kind === 'tool_call_update') onTool(update);
    else if (kind === 'plan' && Array.isArray(update.entries)) {
      const steps = update.entries.map((entry: Record<string, unknown>) =>
        `${entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◉' : '○'} ${String(entry.content ?? '')}`);
      services.event('activity', { id: 'native-plan', kind: 'text', text: steps.join('\n') });
    }
  };

  const onRequest = async (message: RpcMessage) => {
    const params = message.params ?? {};
    if (message.method === 'session/request_permission') {
      const options: { optionId?: string; kind?: string }[] = Array.isArray(params.options) ? params.options : [];
      const pick = (kind: string) => options.find(option => option.kind === kind)?.optionId;
      const requestSignal = turnAbort.signal;
      const { tool, input } = describeToolCall(params.toolCall ?? {});
      if (tools && isHubToolCall(params.toolCall ?? {}, services.config.orchestration?.tools.map(item => item.name) ?? [])) {
        const optionId = pick('allow_once');
        rpc.send({ id: message.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
        return;
      }
      if (tool === 'Bash' && home.shell) await services.verifyShell();
      // Full access lets the CLI's own rules decide; agy has no mode that skips its asks, so the Hub allows them.
      const writes = ['edit', 'delete', 'move'].includes(String(params.toolCall?.kind ?? '')) || ['Write', 'Edit'].includes(tool);
      // A child confined to a directory may change only paths agy names inside it; a change naming none is refused.
      const targets = [input.file_path, ...(Array.isArray(params.toolCall?.locations) ? params.toolCall.locations.map((location: { path?: unknown }) => location.path) : [])]
        .filter((target): target is string => typeof target === 'string');
      const outside = writes && !!context.session.agent_directory && (!targets.length
        || (await Promise.all(targets.map(target => assertWritable(context, target).then(() => false, () => true)))).some(Boolean));
      const decision = (context.session.agent_access === 'read' && writes) || outside ? { decision: 'deny' as const }
        : getPermissionMode(context.session) === 'full-access' && context.session.agent_mode !== 'plan'
          ? { decision: 'allow' as const } : await services.approve(tool, input, requestSignal);
      const optionId = requestSignal.aborted ? undefined : pick(decision.decision === 'allow' ? 'allow_once' : 'reject_once');
      rpc.send({ id: message.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
      return;
    }
    if (message.method === 'elicitation/create') {
      const questions = formQuestions(params.requestedSchema);
      if (!questions.length) { rpc.send({ id: message.id, result: { action: 'decline' } }); return; }
      const outcome = await services.ask(questions, turnAbort.signal);
      rpc.send({ id: message.id, result: { action: 'accept', content: formContent(params.requestedSchema, questions, outcome) } });
      return;
    }
    rpc.send({ id: message.id, error: { code: -32601, message: '当前工作台不支持此交互请求，请通过对话向用户说明。' } });
  };

  const rpc = new RpcClient(child, async message => {
    if (message.id !== undefined && message.method) await onRequest(message);
    else if (message.method === 'session/update' && message.params?.sessionId === sessionId) onUpdate(message.params.update ?? {});
  }, fail, services.control, { name: 'Antigravity', connection: 'Antigravity ACP', jsonrpc: true });

  const promptEnded = (result: any, error?: Error) => {
    prompts--;
    const record = result?.usage ? antigravityUsage(model, result.usage) : null;
    if (record) services.recordTokenUsage({ records: [record] });
    if (prompts > 0 || !turnActive) return;
    const reason = result?.stopReason;
    if (error) endTurn('error', error.message);
    else if (interruptRequested || reason === 'cancelled') endTurn('interrupted');
    else if (reason === 'end_turn') endTurn('completed');
    else endTurn('error', reason === 'refusal' ? '模型拒绝了这次请求' : `Antigravity 本轮提前结束（${String(reason)}）`);
  };
  const sendPrompt = (input: AgentPrompt) => {
    prompts++;
    const blocks = [...input.images.map(image => ({ type: 'image', mimeType: image.mediaType, data: image.data })),
      ...(input.text ? [{ type: 'text', text: input.text }] : [])];
    void rpc.request('session/prompt', { sessionId, prompt: blocks }, PROMPT_TIMEOUT_MS)
      .then(result => promptEnded(result), (error: unknown) => promptEnded(undefined, error instanceof Error ? error : new Error(String(error))));
  };

  // The Stop hook marks every end of agy's loop; it is the only sign that a turn agy began by itself is over.
  let stopOffset = 0;
  const readStops = async () => {
    const opened = await openContained(context.runtime_home, '.clinavat-agy-stop.jsonl').catch(() => undefined);
    if (!opened) return;
    let chunk = '';
    try {
      if (opened.size <= stopOffset || opened.size > 4 * 1024 * 1024) return;
      const buffer = Buffer.alloc(opened.size - stopOffset);
      await opened.handle.read(buffer, 0, buffer.length, stopOffset);
      chunk = buffer.toString('utf8');
    } finally { await opened.handle.close(); }
    const complete = chunk.lastIndexOf('\n') + 1;
    stopOffset += Buffer.byteLength(chunk.slice(0, complete));
    for (const line of chunk.slice(0, complete).split('\n').filter(Boolean)) {
      let stop: Record<string, unknown>;
      try { stop = JSON.parse(line); } catch { continue; }
      if (stop.conversationId !== sessionId) continue;
      fullyIdle = stop.fullyIdle !== false;
      // agy states that nothing runs any more, including commands an interrupt ended without a final update.
      if (fullyIdle) runningCommands.clear();
      if (autonomous && turnActive && prompts === 0) endTurn('completed');
      services.activityChanged();
    }
  };
  const stopWatch = setInterval(() => { void readStops().catch(() => undefined); }, 1000);
  stopWatch.unref();

  const abort = () => {
    stopped = true;
    turnAbort.abort();
    if (sessionId) rpc.send({ method: 'session/cancel', params: { sessionId } });
    terminateProcess(child);
  };
  signal.addEventListener('abort', abort, { once: true });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('close', (code, exitSignal) => {
      clearInterval(stopWatch);
      clearTimeout(exitGrace);
      signal.removeEventListener('abort', abort);
      turnAbort.abort();
      rpc.close();
      const reason = failure || diagnostics.trim() || `Antigravity CLI 已退出（${code ?? exitSignal}）`;
      if (!stopped && (turnActive || failure || (!closing && code !== 0))) reject(new Error(reason));
      else resolve();
    });
  }).finally(() => closed);
  void completion.catch(() => undefined);

  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await services.verifyShell();
    const initialized = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'clinavat', title: 'Clinavat', version: '0.1.0' } }, 60_000);
    if (initialized?.protocolVersion !== 1) throw new Error('ACP 协议版本不兼容');
    const planning = context.session.agent_mode === 'plan';
    const instructions = conversationInstructions(context, 'antigravity') + (planning
      ? '\nThe user selected Plan mode in the web UI. When the plan is complete, present the whole plan in your final response: the user cannot open files outside the project.' : '');
    const opening = { cwd: workingDirectory(context), mcpServers: tools ? [tools.server] : [],
      _meta: { antigravity: { systemPrompt: { append: instructions } } } };
    const nativeId = context.session.native_session_id;
    const session = nativeId ? await rpc.request('session/resume', { ...opening, sessionId: nativeId }, 120_000)
      : await rpc.request('session/new', opening, 120_000);
    sessionId = nativeId ?? String(session?.sessionId ?? '');
    if (!sessionId) throw new Error('Antigravity 未返回会话 ID');
    if (signal.aborted) throw new Error('会话已停止');
    await services.update({ native_session_id: sessionId });
    let options: ConfigOption[] = Array.isArray(session?.configOptions) ? session.configOptions : [];
    const choose = async (category: string, value: string, required: string) => {
      const option = options.find(item => item.category === category);
      if (!option?.options?.some(item => item.value === value)) throw new Error(required);
      if (option.currentValue === value) return;
      const changed = await rpc.request('session/set_config_option', { sessionId, configId: option.id, value }, 30_000);
      if (Array.isArray(changed?.configOptions)) options = changed.configOptions;
    };
    if (context.session.model) await choose('model', context.session.model, `当前账号不提供模型 ${context.session.model}，请刷新模型列表后重新选择`);
    if (context.session.reasoning_effort) await choose('thought_level', context.session.reasoning_effort, '所选模型不支持该思考强度');
    const mode = planning ? 'plan' : getPermissionMode(context.session) === 'accept-edits' ? 'accept-edits' : 'default';
    await choose('mode', mode, `Antigravity 不提供 ${mode} 模式`);
    model = String(options.find(item => item.category === 'model')?.currentValue ?? model);
    sendPrompt(prompt);
  } catch (error) {
    signal.removeEventListener('abort', abort);
    clearInterval(stopWatch);
    rpc.close();
    terminateProcess(child);
    await closed;
    await completion.catch(() => undefined);
    throw new Error(`Antigravity 启动失败：${error instanceof Error ? error.message : '协议不兼容'}`);
  }

  return {
    process: child, completion, stop: abort,
    readUsage: () => antigravityProbe({ execution, scope, home: context.runtime_home, binary }),
    startTurn: async (input) => {
      if (closing || stopped) throw new Error('Antigravity CLI 正在退出');
      beginTurn();
      sendPrompt(input);
    },
    steer: async (input) => {
      if (!turnActive || autonomous || stopped) return false;
      sendPrompt(input);
      return true;
    },
    interruptTurn: async () => {
      if (!turnActive) return;
      interruptRequested = true;
      turnAbort.abort();
      rpc.send({ method: 'session/cancel', params: { sessionId } });
      // A turn agy began by itself has no prompt whose response would end it.
      if (prompts === 0) endTurn('interrupted');
    },
    isIdle: () => !turnActive && prompts === 0 && !runningCommands.size && fullyIdle,
    close: () => {
      if (closing) return;
      closing = true;
      // Closing stdin lets agy finish saving the conversation before it exits.
      child.stdin.end();
      exitGrace = setTimeout(() => terminateProcess(child), EXIT_GRACE_MS);
      exitGrace.unref();
    },
    tasks: () => [],
    stopTask: async () => { throw new Error('Antigravity 不提供后台任务控制'); },
  };
}
