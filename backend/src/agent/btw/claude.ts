import { randomUUID } from 'node:crypto';
import type { ClaudeControl } from '../claude/control.js';
import { agentEnvironment, agentScope, observeProcessClose, terminateProcess, vmWorkingDirectory } from '../environment.js';
import { readJsonLines } from '../ndjson.js';
import { BTW_SYSTEM_PROMPT, buildBtwUserPrompt } from './context.js';
import type { BtwEngineInput, BtwHistoryEntry } from './types.js';

const SIDE_QUESTION_TIMEOUT_MS = 120_000;

/** Extracts text from Claude Code 2.1.310 `side_question` control_response payloads. */
export function extractClaudeSideQuestionAnswer(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.trim() || null;
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.response === 'string' && record.response.trim()) return record.response.trim();
  const fallback = record.refusal_fallback as Record<string, unknown> | undefined;
  if (typeof fallback?.content === 'string' && fallback.content.trim()) return fallback.content.trim();
  if (typeof record.answer === 'string' && record.answer.trim()) return record.answer.trim();
  if (typeof record.text === 'string' && record.text.trim()) return record.text.trim();
  return null;
}

export async function runClaudeResidentSideQuestion(
  control: ClaudeControl,
  question: string,
  signal: AbortSignal,
  options: { history?: BtwHistoryEntry[]; onProgress?: (event: Record<string, unknown>) => void } = {},
): Promise<string | null> {
  if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');
  const payload = await control.request(
    {
      subtype: 'side_question',
      question,
      ...(options.history?.length ? { history: options.history } : {}),
    },
    { timeoutMs: SIDE_QUESTION_TIMEOUT_MS, signal, onProgress: options.onProgress },
  );
  return extractClaudeSideQuestionAnswer(payload);
}

function claudeColdBaseArgs(context: BtwEngineInput['context']): string[] {
  // Never pass `--bare`: OAuth subscription slots require the slot's normal credential loading.
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--restricted',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--tools', '',
    '--model', context.session.model || 'default',
    ...(context.session.reasoning_effort ? ['--effort', context.session.reasoning_effort] : []),
  ];
}

async function runClaudeResumedSideQuestion(input: BtwEngineInput, nativeId: string): Promise<string | null> {
  const { config, context, question, history, signal, onProgress } = input;
  if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');
  const scope = agentScope(context, config.workspaceDir);
  const binary = await config.execution.binary(scope, 'claude');
  const cwd = vmWorkingDirectory(context, config.workspaceDir);
  const args = [...claudeColdBaseArgs(context), '--resume', nativeId];
  const child = await config.execution.spawn(binary, args, {
    scope,
    cwd,
    env: agentEnvironment(config.execution, context, scope),
    secrets: await config.credentials.secretEnvironment(context.slot.id),
  });
  const closed = observeProcessClose(child);
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });

  const initId = randomUUID();
  const sideId = randomUUID();
  let closeLines: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const writeFrame = (frame: Record<string, unknown>) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify(frame) + '\n');
    }
  };

  try {
    return await new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error, value?: string | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? null);
      };
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => settle(new Error('Claude 旁路提问超时')), SIDE_QUESTION_TIMEOUT_MS);
      };
      const onAbort = () => {
        try { writeFrame({ type: 'control_cancel_request', request_id: sideId }); } catch { /* ignore */ }
        terminateProcess(child);
        settle(new DOMException('旁路提问已取消', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      resetTimer();

      const lines = readJsonLines(child.stdout, event => {
        if (event.type === 'system' && event.subtype === 'control_request_progress' && event.request_id === sideId) {
          resetTimer();
          onProgress?.(event);
          return;
        }
        if (event.type !== 'control_response') return;
        const response = event.response;
        if (response?.request_id === initId) {
          if (response.subtype !== 'success') {
            settle(new Error(String(response.error || 'Claude 旁路初始化失败')));
            return;
          }
          try {
            writeFrame({
              type: 'control_request',
              request_id: sideId,
              request: {
                subtype: 'side_question',
                question,
                ...(history.length ? { history } : {}),
              },
            });
          } catch (error) {
            settle(error instanceof Error ? error : new Error('发送 Claude 旁路提问失败'));
          }
          return;
        }
        if (response?.request_id === sideId) {
          if (response.subtype !== 'success' || response.error) {
            settle(new Error(String(response.error || 'Claude 旁路提问失败')));
          } else {
            settle(undefined, extractClaudeSideQuestionAnswer(response.response));
          }
        }
      }, error => settle(error));
      closeLines = lines.close;

      child.once('error', error => settle(error));
      child.once('close', code => settle(new Error(diagnostics.trim() || `Claude 旁路进程提前退出（${code ?? 'signal'}）`)));
      child.stdin.once('error', error => settle(error));
      try {
        writeFrame({ type: 'control_request', request_id: initId, request: { subtype: 'initialize' } });
      } catch (error) {
        settle(error instanceof Error ? error : new Error('Claude 旁路初始化写入失败'));
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    closeLines?.();
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    terminateProcess(child);
    await closed.catch(() => undefined);
  }
}

async function runClaudeSnapshotTurn(input: BtwEngineInput): Promise<string> {
  const { config, context, question, snapshot, signal, onDelta } = input;
  if (signal.aborted) throw new DOMException('旁路提问已取消', 'AbortError');
  const scope = agentScope(context, config.workspaceDir);
  const binary = await config.execution.binary(scope, 'claude');
  const cwd = vmWorkingDirectory(context, config.workspaceDir);
  const args = [
    ...claudeColdBaseArgs(context),
    '--include-partial-messages',
    '--max-turns', '1',
    '--append-system-prompt', BTW_SYSTEM_PROMPT,
  ];
  const child = await config.execution.spawn(binary, args, {
    scope,
    cwd,
    env: agentEnvironment(config.execution, context, scope),
    secrets: await config.credentials.secretEnvironment(context.slot.id),
  });
  const closed = observeProcessClose(child);
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });

  const initId = randomUUID();
  let closeLines: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let streamed = '';
  let assistantText = '';
  const writeFrame = (frame: Record<string, unknown>) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify(frame) + '\n');
    }
  };

  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const onAbort = () => {
        terminateProcess(child);
        settle(new DOMException('旁路提问已取消', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => settle(new Error('Claude 旁路提问超时')), SIDE_QUESTION_TIMEOUT_MS);

      const lines = readJsonLines(child.stdout, event => {
        if (event.type === 'control_response' && event.response?.request_id === initId) {
          if (event.response.subtype !== 'success') {
            settle(new Error(String(event.response.error || 'Claude 旁路初始化失败')));
            return;
          }
          try {
            writeFrame({
              type: 'user',
              session_id: '',
              parent_tool_use_id: null,
              message: { role: 'user', content: buildBtwUserPrompt(question, snapshot) },
            });
          } catch (error) {
            settle(error instanceof Error ? error : new Error('发送 Claude 旁路问题失败'));
          }
          return;
        }
        if (event.type === 'control_request' && event.request_id) {
          // Hard-deny any unexpected tool request on the read-only fallback path.
          try {
            writeFrame({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: event.request_id,
                response: { behavior: 'deny', message: '旁路提问模式禁用所有工具调用' },
              },
            });
          } catch { /* ignore */ }
          return;
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta'
          && event.event?.delta?.type === 'text_delta') {
          const delta = String(event.event.delta.text ?? '');
          if (delta) {
            streamed += delta;
            onDelta(delta);
          }
          return;
        }
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const text = event.message.content
            .filter((entry: Record<string, unknown>) => entry.type === 'text' && typeof entry.text === 'string')
            .map((entry: Record<string, unknown>) => String(entry.text))
            .join('\n\n')
            .trim();
          if (text) assistantText = text;
          return;
        }
        if (event.type === 'result') {
          if (event.is_error || (event.subtype && event.subtype !== 'success')) {
            const errors = Array.isArray(event.errors) ? event.errors.join('\n') : '';
            settle(new Error(errors || String(event.result || event.api_error || 'Claude 旁路提问失败')));
            return;
          }
          const finalText = streamed.trim() || assistantText || String(event.result ?? '').trim();
          if (!streamed && finalText) onDelta(finalText);
          settle(undefined, finalText);
        }
      }, error => settle(error));
      closeLines = lines.close;

      child.once('error', error => settle(error));
      child.once('close', code => {
        const fallback = streamed.trim() || assistantText;
        if (fallback && code === 0) settle(undefined, fallback);
        else settle(new Error(diagnostics.trim() || `Claude 旁路进程退出（${code ?? 'signal'}）`));
      });
      child.stdin.once('error', error => settle(error));
      try {
        writeFrame({ type: 'control_request', request_id: initId, request: { subtype: 'initialize' } });
      } catch (error) {
        settle(error instanceof Error ? error : new Error('Claude 旁路初始化写入失败'));
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    closeLines?.();
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    terminateProcess(child);
    await closed.catch(() => undefined);
  }
}

/** Cold/paused Claude /btw: tries `--resume <nativeId>` + `side_question` first, then falls back to read-only snapshot turn. */
export async function runClaudeBtw(input: BtwEngineInput): Promise<string> {
  const nativeId = input.context.session.native_session_id;
  if (nativeId) {
    try {
      const answer = await runClaudeResumedSideQuestion(input, nativeId);
      if (answer) {
        input.onDelta(answer);
        return answer;
      }
    } catch (error) {
      if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      // Fall back to read-only snapshot turn when native resume or side_question is unavailable.
    }
  }
  return runClaudeSnapshotTurn(input);
}
