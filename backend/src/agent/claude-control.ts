import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RunServices } from './types.js';
import { answerClaudeQuestions } from './claude-questions.js';
import { denyHook, preToolUseDecision, validHookOutput } from './hooks.js';

const preToolUseCallback = 'clinavat-pre-tool-use';

interface Initialization {
  id: string;
  cancelTimeout(): void;
  resolve(): void;
  reject(error: Error): void;
}

export class ClaudeControl {
  private initialization?: Initialization;
  private requests = new Map<string, AbortController>();
  private checkedToolUses = new Set<string>();
  closed = false;

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private services: RunServices,
    private onError: (error: Error) => void,
  ) {}

  async start(prompt: string): Promise<void> {
    if (this.closed) throw new Error('Claude CLI 控制通道已关闭');
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const cancelTimeout = this.services.control.timer(() => {
        this.initialization = undefined;
        reject(new Error('Claude CLI 控制协议初始化超时'));
      }, 60_000);
      this.initialization = { id, cancelTimeout, resolve, reject };
      try {
        this.write({ type: 'control_request', request_id: id, request: { subtype: 'initialize', hooks: { PreToolUse: [{
          matcher: '.*', hookCallbackIds: [preToolUseCallback],
          // An unanswered callback blocks the tool. Hub deadlines exclude paused time; this native one uses wall time even after SIGSTOP.
          timeout: Math.max(86400, Math.ceil(this.services.config.approvalTimeoutMs / 1000) + 10),
        }] } } });
      } catch (error) {
        this.close(error instanceof Error ? error : new Error('Claude CLI 初始化失败'));
      }
    });
    if (!this.services.context.session.resume_interrupted) {
      this.write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
    }
  }

  handle(event: Record<string, any>): boolean {
    if (event.type === 'control_response') {
      const response = event.response;
      if (this.initialization && response?.request_id === this.initialization.id) {
        const initialization = this.initialization;
        this.initialization = undefined;
        initialization.cancelTimeout();
        if (response.subtype === 'error') initialization.reject(new Error(String(response.error || 'Claude CLI 初始化失败')));
        else initialization.resolve();
      }
      return true;
    }
    if (event.type === 'control_cancel_request' || event.type === 'cancel_control_request') {
      const id = String(event.request_id ?? '');
      this.requests.get(id)?.abort();
      this.requests.delete(id);
      return true;
    }
    if (event.type !== 'control_request') return false;
    const id = String(event.request_id ?? '');
    if (!id || this.closed || this.requests.has(id)) return true;
    const token = new AbortController();
    this.requests.set(id, token);
    if (event.request?.subtype === 'hook_callback') {
      void this.respondHook(id, token, event.request).finally(() => {
        if (this.requests.get(id) === token) this.requests.delete(id);
      });
      return true;
    }
    void this.respond(id, token, event.request).catch((error: unknown) => {
      if (!this.closed) this.onError(error instanceof Error ? error : new Error('Claude CLI 审批响应失败'));
    }).finally(() => {
      if (this.requests.get(id) === token) this.requests.delete(id);
    });
    return true;
  }

  /** Every executed tool must have passed the Hub's PreToolUse callback; anything else means the gate was bypassed. */
  wasChecked(toolUseId: string): boolean { return this.checkedToolUses.has(toolUseId); }

  close(error = new Error('Claude CLI 控制通道已关闭')): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    if (this.initialization) {
      this.initialization.cancelTimeout();
      this.initialization.reject(error);
      this.initialization = undefined;
    }
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
  }

  private write(value: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error('Claude CLI 控制通道已关闭');
    }
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  // Never answers with an error: the CLI would treat it as no opinion and run the tool.
  private async respondHook(id: string, token: AbortController, request: Record<string, any>): Promise<void> {
    if (typeof request.tool_use_id === 'string') this.checkedToolUses.add(request.tool_use_id);
    const input = request.input;
    const output = request.callback_id !== preToolUseCallback ? denyHook('未知的工具审批回调')
      : !input || typeof input !== 'object' || Array.isArray(input) ? denyHook('工具审批输入无效')
        : validHookOutput(await preToolUseDecision(this.services, input).catch((error: unknown) =>
          denyHook(error instanceof Error ? error.message : '工具路径或审批校验失败')));
    if (this.closed || token.signal.aborted || this.requests.get(id) !== token) return;
    try { this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: output } }); }
    catch (error) { if (!this.closed) this.onError(error instanceof Error ? error : new Error('Claude CLI 审批响应失败')); }
  }

  private async respond(id: string, token: AbortController, request: Record<string, unknown> | undefined): Promise<void> {
    let response: Record<string, unknown>;
    try {
      if (request?.subtype !== 'can_use_tool') throw new Error(`不支持的 CLI 控制请求：${String(request?.subtype ?? '')}`);
      if (typeof request.tool_name !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
        throw new Error('CLI 工具审批输入无效');
      }
      const input = request.input as Record<string, unknown>;
      if (request.tool_name === 'AskUserQuestion') {
        const updatedInput = input.answers && typeof input.answers === 'object'
          ? input : await answerClaudeQuestions(this.services, input, token.signal);
        const response = updatedInput ? {
          behavior: 'allow', updatedInput,
        } : { behavior: 'deny', message: '用户跳过了这些问题，请基于已有信息继续，不要假定任何选项已获用户同意。' };
        if (!this.closed && !token.signal.aborted && this.requests.get(id) === token) {
          this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
        }
        return;
      }
      const approval = await this.services.approve(request.tool_name, input, token.signal);
      response = {
        subtype: 'success', request_id: id,
        response: {
          ...(approval.decision === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: approval.reason || '用户拒绝执行' }),
          ...(request.tool_use_id ? { toolUseID: request.tool_use_id } : {}),
        },
      };
    } catch (error) {
      response = { subtype: 'error', request_id: id, error: error instanceof Error ? error.message : '工具审批失败' };
    }
    // A cancelled request no longer belongs to the CLI, even if its web approval resolves later.
    if (!this.closed && !token.signal.aborted && this.requests.get(id) === token) this.write({ type: 'control_response', response });
  }
}
