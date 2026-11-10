import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { openContained } from '../runtime/contained-files.js';
import type { AgentCallbacks, AgentContext, ApprovalDecision } from './types.js';
import type { RunControl } from './run-control.js';

export async function shellHash(context: AgentContext): Promise<string> {
  if (context.project.execution_mode === 'local') {
    const directory = await realpath(context.project.local_path);
    if (directory !== context.project.local_path || !(await stat(directory)).isDirectory()) {
      throw new Error('本机项目目录已发生变化，请重新打开项目');
    }
    return directory;
  }
  try {
    const { handle } = await openContained(context.project.local_path, '.bin/remote-shell');
    try { return createHash('sha256').update(await handle.readFile()).digest('hex'); }
    finally { await handle.close(); }
  } catch { throw new Error('项目远程执行器尚未准备好，请先重新同步项目'); }
}

export function awaitApproval(callbacks: AgentCallbacks, timeout: number, sessionId: string, tool: string,
  input: Record<string, unknown>, signal: AbortSignal, control: RunControl): Promise<ApprovalDecision> {
  if (signal.aborted) return Promise.resolve({ decision: 'deny', reason: '审批已取消' });
  const request = new AbortController();
  return new Promise(resolve => {
    let settled = false;
    const finish = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      signal.removeEventListener('abort', abort);
      request.abort();
      resolve(decision);
    };
    const abort = () => finish({ decision: 'deny', reason: '审批已停止' });
    const cancelTimeout = control.timer(() => finish({ decision: 'deny', reason: '审批超时，已自动拒绝' }), timeout);
    signal.addEventListener('abort', abort, { once: true });
    void callbacks.approval({ sessionId, tool, input, signal: request.signal,
      scheduleTimeout: (callback, milliseconds) => control.timer(callback, milliseconds) }).then(finish)
      .catch(() => finish({ decision: 'deny', reason: '审批服务不可用，已拒绝' }));
  });
}
