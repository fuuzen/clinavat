import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { agentEnvironment, findExecutable, terminateProcess } from './environment.js';
import { createHookServer } from './hooks.js';
import { readJsonLines } from './ndjson.js';
import type { AgentRun, RunServices } from './types.js';

async function transcriptPath(home: string, nativeId: string): Promise<string | undefined> {
  const projects = path.join(home, '.claude', 'projects');
  for (const directory of await readdir(projects, { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory()) continue;
    const files = await readdir(path.join(projects, directory.name)).catch((): string[] => []);
    if (files.includes(`${nativeId}.jsonl`)) return path.join(projects, directory.name, `${nativeId}.jsonl`);
  }
  return undefined;
}

export async function startClaude(services: RunServices, prompt: string): Promise<AgentRun> {
  const binary = await findExecutable(services.config.claudeBinary);
  const hook = await createHookServer(services);
  const nativeId = services.context.session.native_session_id || randomUUID();
  const settings = {
    hooks: { PreToolUse: [{ matcher: '.*', hooks: [{
      type: 'command', command: hook.command, args: hook.args, onFailure: 'block',
      timeout: Math.ceil(services.config.approvalTimeoutMs / 1000) + 10,
    }] }] },
    permissions: { defaultMode: 'default', deny: ['.bin', '.git', '.claude', '.codex'].flatMap((directory) => {
      const root = `/${services.context.project.local_path}`;
      return [`${root}/${directory}/**`, `${root}/**/${directory}/**`]
        .flatMap((pattern) => [`Read(${pattern})`, `Edit(${pattern})`]);
    }) },
  };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--restricted', '--setting-sources', '', '--settings', JSON.stringify(settings),
    '--tools', 'Bash,Read,Edit,Write,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--model', services.context.session.model || 'default',
    ...(services.context.session.reasoning_effort ? ['--effort', services.context.session.reasoning_effort] : []),
    ...(services.context.session.native_session_id ? ['--resume', nativeId] : ['--session-id', nativeId])];
  const child = spawn(binary, args, {
    cwd: services.context.project.local_path, env: agentEnvironment(services.context),
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  let resultError = '';
  let messageId = '';
  let activeTextIndex: number | undefined;
  let textSize = 0;
  const messages = new Map<string, string>();
  const messageGroups = new Map<string, string>();
  const thinkingBlocks = new Map<number, string>();
  let stopped = false;
  let nativeSessionReceived = false;
  const inputError = (error: Error) => { resultError = error.message; terminateProcess(child); };
  child.stdin.on('error', inputError);
  const lines = readJsonLines(child.stdout, (event) => {
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
      if (nested?.type === 'content_block_start' && nested.content_block?.type === 'thinking') {
        const id = `${messageId}:thinking:${nested.index}`;
        thinkingBlocks.set(nested.index, id);
        services.event('activity', { id, kind: 'reasoning', text: '正在思考…' });
      }
      if (nested?.type === 'content_block_stop' && thinkingBlocks.has(nested.index)) {
        services.event('activity', { id: thinkingBlocks.get(nested.index), kind: 'reasoning', text: '思考已完成' });
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
        if (entry.type === 'tool_result') services.event('tool', {
          id: entry.tool_use_id, status: entry.is_error ? 'failed' : 'completed',
          output: (typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? '')).slice(0, 128 * 1024),
        });
      }
    }
    if (event.type === 'result') {
      if (event.is_error || (event.subtype && event.subtype !== 'success')) {
        resultError = Array.isArray(event.errors) ? event.errors.join('\n') : String(event.result ?? event.subtype);
      } else if (!messages.size && event.result) {
        const id = randomUUID();
        const text = String(event.result);
        if (text.length > 8 * 1024 * 1024) { inputError(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return; }
        messages.set(id, text);
        messageGroups.set(id, id);
        services.event('activity', { id, kind: 'text', text });
      }
    }
  }, inputError);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-16 * 1024); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      void (async () => {
        try {
          const finalGroup = !stopped && code === 0 && !resultError ? messageGroups.get([...messages.keys()].at(-1) || '') : undefined;
          const finalIds = finalGroup ? [...messages.keys()].filter(id => messageGroups.get(id) === finalGroup) : [];
          const output = finalIds.map(id => messages.get(id)).join('\n\n');
          if (output.trim()) {
            for (const id of finalIds) services.event('activity', { id, kind: 'text', text: messages.get(id) || '', final: true });
            await services.output(output.trim());
          }
          if (nativeSessionReceived) {
            const transcript = await transcriptPath(services.context.slot.home_dir, nativeId);
            if (transcript) await services.update({ jsonl_file_path: transcript });
          }
          if (!stopped && (code !== 0 || resultError)) {
            throw new Error(resultError || diagnostics.trim() || `Claude CLI 已退出（${code ?? signal}）`);
          }
          resolve();
        } catch (error) { reject(error); }
        finally { lines.close(); await hook.close(); }
      })();
    });
  });
  // Attach the rejection handler before awaiting spawn: an unavailable binary can fail immediately.
  void completion.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.stdin.end(prompt);
  } catch (error) { await hook.close(); throw error; }
  return { process: child, completion, stop() { stopped = true; terminateProcess(child); } };
}
