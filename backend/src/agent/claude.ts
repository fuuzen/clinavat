import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeControl } from './claude-control.js';
import { agentEnvironment, agentScope, observeProcessClose, terminateProcess } from './environment.js';
import { readJsonLines } from './ndjson.js';
import { claudePermissionMode } from './permissions.js';
import { projectInstructions } from './project-instructions.js';
import { ClaudeQuotaTracker } from './claude-quota.js';
import { parseClaudeUsage } from '../accounts/usage-parsers.js';
import type { AgentRun, RunServices, RunTask } from './types.js';

// How long a CLI told to finish may take, including stopping its background tasks.
const EXIT_GRACE_MS = 10_000;

async function transcriptPath(home: string, nativeId: string): Promise<string | undefined> {
  const projects = path.join(home, '.claude', 'projects');
  for (const directory of await readdir(projects, { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory()) continue;
    const files = await readdir(path.join(projects, directory.name)).catch((): string[] => []);
    if (files.includes(`${nativeId}.jsonl`)) return path.join(projects, directory.name, `${nativeId}.jsonl`);
  }
  return undefined;
}

export async function startClaude(services: RunServices, prompt: string, signal?: AbortSignal): Promise<AgentRun> {
  if (signal?.aborted) throw new Error('会话已停止');
  const { execution } = services.config;
  const binary = await execution.binary(agentScope(services.context), 'claude');
  const plansDirectory = path.join(services.context.runtime_home, '.claude', 'plans');
  await mkdir(plansDirectory, { recursive: true, mode: 0o700 });
  if (signal?.aborted) throw new Error('会话已停止');
  const nativeId = services.context.session.native_session_id || randomUUID();
  const permissionMode = services.context.session.agent_mode === 'plan' ? 'plan' : claudePermissionMode(services.context.session);
  const settings = {
    plansDirectory,
    permissions: { deny: ['.bin', '.git', '.claude', '.codex'].flatMap((directory) => {
      const root = `/${services.context.project.local_path}`;
      return [`${root}/${directory}/**`, `${root}/**/${directory}/**`]
        .flatMap((pattern) => [`Read(${pattern})`, `Edit(${pattern})`]);
    }) },
  };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // Without summarized display the API streams thinking blocks with empty text.
    '--thinking-display', 'summarized',
    ...(permissionMode === 'bypassPermissions' ? [] : ['--restricted']),
    '--permission-mode', permissionMode, '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    '--setting-sources', '', '--settings', JSON.stringify(settings),
    '--append-system-prompt', projectInstructions(services.context.project, 'claude') + (permissionMode === 'plan'
      ? '\nThe user selected Plan mode in the web UI. Stay in Plan mode for this turn. When the plan is complete, present it in your final response and tell the user they can switch to Normal to implement it. Do not use ExitPlanMode to change the selected mode.' : ''),
    '--tools', 'Bash,Read,Edit,Write,Glob,Grep,AskUserQuestion,ExitPlanMode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--model', services.context.session.model || 'default',
    ...(services.context.session.reasoning_effort ? ['--effort', services.context.session.reasoning_effort] : []),
    ...(services.context.session.native_session_id ? ['--resume', nativeId] : ['--session-id', nativeId])];
  const child = await execution.spawn(binary, args, {
    scope: agentScope(services.context), cwd: services.context.project.local_path, env: agentEnvironment(execution, services.context),
  });
  services.control.track(child);
  const closed = observeProcessClose(child);
  let diagnostics = '';
  let resultError = '';
  const quota = new ClaudeQuotaTracker();
  let messageId = '';
  let activeTextIndex: number | undefined;
  const thinkingBlocks = new Set<number>();
  let textSize = 0;
  const messages = new Map<string, string>();
  const messageGroups = new Map<string, string>();
  let stopped = false;
  let nativeSessionReceived = false;
  let turnActive = true;
  let interruptRequested = false;
  let closing = false;
  let exitGrace: NodeJS.Timeout | undefined;
  let lastTaskSummary = '';
  let tasks: RunTask[] = [];
  // Steering sent while a turn was ending starts its own turn; its message already exists.
  const pendingSteers = new Map<string, string>();
  const inputError = (error: Error) => { resultError = error.message; control.close(error); terminateProcess(child); };
  const control = new ClaudeControl(child, services, inputError);
  const stop = () => { stopped = true; control.close(new Error('会话已停止')); terminateProcess(child); };
  child.stdin.on('error', (error) => { if (!control.closed) inputError(error); });
  const endTurn = (result?: Record<string, unknown>) => {
    if (!turnActive) return;
    turnActive = false;
    const failure = resultError;
    const exhaustion = result ? quota.finish(result) : undefined;
    if (!result) quota.reset();
    const wasInterrupted = interruptRequested;
    const finalGroup = !failure ? messageGroups.get([...messages.keys()].at(-1) || '') : undefined;
    const finalIds = finalGroup ? [...messages.keys()].filter(id => messageGroups.get(id) === finalGroup) : [];
    const finalTexts = finalIds.map(id => ({ id, text: messages.get(id) || '' }));
    // The next turn may begin immediately, so its text must never mix with this one's.
    resultError = '';
    interruptRequested = false;
    messageId = '';
    activeTextIndex = undefined;
    textSize = 0;
    messages.clear();
    messageGroups.clear();
    thinkingBlocks.clear();
    for (const { id, text } of finalTexts) services.event('activity', { id, kind: 'text', text, final: true });
    const output = finalTexts.map(item => item.text).join('\n\n').trim()
      || (services.context.session.command === 'compact' && !failure ? '原生上下文已压缩。网页中的历史消息仍会保留。' : '');
    services.turnEnded(wasInterrupted ? { status: 'interrupted', output }
      : failure ? { status: 'error', error: failure, output, quota: exhaustion } : { status: 'completed', output });
    if (nativeSessionReceived) void transcriptPath(services.context.runtime_home, nativeId)
      .then(transcript => transcript ? services.update({ jsonl_file_path: transcript }) : undefined).catch(() => undefined);
  };
  const lines = readJsonLines(child.stdout, (event) => {
    if (control.handle(event)) return;
    if (event.type === 'command_lifecycle' && event.state === 'started' && !turnActive && pendingSteers.has(event.command_uuid)) {
      turnActive = true;
      services.automaticTurn({ messageId: pendingSteers.get(event.command_uuid)! });
    }
    if (event.type === 'command_lifecycle' && ['started', 'completed', 'cancelled'].includes(event.state)) {
      pendingSteers.delete(event.command_uuid);
      services.activityChanged();
    }
    if (event.type === 'system' && event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
      tasks = event.tasks.map((task: Record<string, unknown>) => ({
        id: String(task.task_id), description: String(task.description ?? ''), type: String(task.task_type ?? ''),
      }));
      services.activityChanged();
    }
    if (event.type === 'system' && event.subtype === 'task_notification') lastTaskSummary = String(event.summary ?? '');
    // After a background task the CLI may emit an empty init/result pair first; only a model request is a real turn.
    if (event.type === 'system' && event.subtype === 'status' && event.status === 'requesting' && !turnActive) {
      turnActive = true;
      services.automaticTurn({ summary: lastTaskSummary });
    }
    if (event.type === 'rate_limit_event') services.config.usage?.observe(services.context.slot, 'claude-event',
      event.rate_limit_info, services.context.account_identity);
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      nativeSessionReceived = true;
      void services.update({ native_session_id: String(event.session_id) }).catch((error: unknown) => {
        resultError = error instanceof Error ? error.message : '原生会话状态保存失败';
        terminateProcess(child);
      });
    }
    if (event.type === 'stream_event') {
      const nested = event.event;
      if (nested?.type === 'message_start') {
        messageId = String(nested.message?.id || randomUUID());
        activeTextIndex = undefined;
        thinkingBlocks.clear();
      }
      if (nested?.type === 'content_block_start' && nested.content_block?.type === 'text') {
        activeTextIndex = nested.index;
      }
      if (nested?.type === 'content_block_start' && nested.content_block?.type === 'thinking') thinkingBlocks.add(nested.index);
      if (nested?.type === 'content_block_delta' && nested.delta?.type === 'thinking_delta' && thinkingBlocks.has(nested.index)) {
        const text = String(nested.delta.thinking ?? '');
        if (text) {
          if (textSize + text.length > 8 * 1024 * 1024) {
            inputError(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
          }
          textSize += text.length;
          services.event('activity', { id: `${messageId}:thinking:${nested.index}`, kind: 'reasoning', text, append: true });
        }
      }
      if (nested?.type === 'content_block_stop' && nested.index === activeTextIndex) activeTextIndex = undefined;
      if (nested?.type === 'content_block_delta' && nested.delta?.type === 'text_delta') {
        const text = String(nested.delta.text ?? '');
        if (textSize + text.length > 8 * 1024 * 1024) {
          inputError(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
        }
        if (!messageId) messageId = randomUUID();
        const id = `${messageId}:block:${nested.index ?? activeTextIndex ?? 0}`;
        textSize += text.length;
        messages.set(id, (messages.get(id) || '') + text);
        messageGroups.set(id, messageId);
        services.event('activity', { id, kind: 'text', text, append: true });
      }
    }
    if (event.type === 'assistant') {
      quota.observeAssistant(event);
      const contents = Array.isArray(event.message?.content) ? event.message.content : [];
      const nativeMessageId = String(event.message?.id || messageId || randomUUID());
      for (const [index, entry] of contents.entries()) {
        if (entry.type !== 'text' || !entry.text) continue;
        const text = String(entry.text);
        // The CLI emits one assistant frame per completed block, sharing the API message ID.
        const id = nativeMessageId === messageId && activeTextIndex !== undefined && contents.length === 1
          ? `${nativeMessageId}:block:${activeTextIndex}`
          : `${nativeMessageId}:frame:${event.uuid || randomUUID()}:${index}`;
        textSize += text.length - (messages.get(id)?.length ?? 0);
        if (textSize > 8 * 1024 * 1024) {
          inputError(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
        }
        messages.set(id, text);
        messageGroups.set(id, nativeMessageId);
        services.event('activity', { id, kind: 'text', text });
      }
      for (const entry of contents) {
        if (entry.type === 'tool_use') services.event('tool', { id: entry.id, tool: entry.name, input: entry.input, status: 'running' });
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const entry of event.message.content) {
        if (entry.type === 'tool_result' && !entry.is_error && !control.wasChecked(String(entry.tool_use_id))) {
          inputError(new Error('工具调用未经过平台审批校验，已停止会话')); return;
        }
        if (entry.type === 'tool_result') services.event('tool', {
          id: entry.tool_use_id, status: entry.is_error ? 'failed' : 'completed',
          output: (typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? '')).slice(0, 128 * 1024),
        });
      }
    }
    if (event.type === 'result') {
      if (event.is_error || (event.subtype && event.subtype !== 'success')) {
        const errors = Array.isArray(event.errors) ? event.errors.join('\n') : '';
        resultError = errors || String(event.result || event.api_error || event.subtype || 'CLI 返回失败结果');
      } else if (!messages.size && event.result) {
        const id = randomUUID();
        const text = String(event.result);
        if (text.length > 8 * 1024 * 1024) { inputError(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return; }
        messages.set(id, text);
        messageGroups.set(id, id);
        services.event('activity', { id, kind: 'text', text });
      }
      endTurn(event);
    }
  }, inputError);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-16 * 1024); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', error => { resultError = error.message; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(exitGrace);
      control.close(new Error(resultError || diagnostics.trim() || `Claude CLI 已退出（${code ?? exitSignal}）`));
      signal?.removeEventListener('abort', stop);
      lines.close();
      // An unexpected exit between turns must still block hand-over after a quota error.
      if (!stopped && (turnActive || (!closing && code !== 0))) {
        reject(new Error(resultError || diagnostics.trim() || `Claude CLI 已退出（${code ?? exitSignal}）`));
      } else resolve();
    });
  }).finally(() => closed);
  // Attach the rejection handler before awaiting spawn: an unavailable binary can fail immediately.
  void completion.catch(() => undefined);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await control.start(prompt);
  } catch (error) {
    signal?.removeEventListener('abort', stop);
    control.close();
    terminateProcess(child);
    await closed;
    await completion.catch(() => undefined);
    throw error;
  }
  return {
    process: child, completion, stop,
    readUsage: async () => parseClaudeUsage(await control.request({ subtype: 'get_usage', skip_behaviors: true }, 30_000)),
    startTurn: async (text) => {
      if (closing) throw new Error('Claude CLI 正在退出');
      quota.reset();
      turnActive = true;
      control.sendUser(text);
    },
    steer: async (text, id) => {
      if (!turnActive) return false;
      const uuid = randomUUID();
      pendingSteers.set(uuid, id);
      control.sendUser(text, { uuid, priority: 'next' });
      return true;
    },
    interruptTurn: async () => {
      if (!turnActive) return;
      interruptRequested = true;
      control.sendControl({ subtype: 'interrupt' });
    },
    isIdle: () => !turnActive && !tasks.length && !pendingSteers.size,
    close: () => {
      if (closing) return;
      closing = true;
      control.close();
      exitGrace = setTimeout(() => terminateProcess(child), EXIT_GRACE_MS);
      exitGrace.unref();
    },
    tasks: () => tasks,
    stopTask: async (taskId) => { control.sendControl({ subtype: 'stop_task', task_id: taskId }); },
  };
}
