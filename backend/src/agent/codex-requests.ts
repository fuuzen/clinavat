import path from 'node:path';
import { getPermissionMode } from './permissions.js';
import type { RpcMessage } from './rpc.js';
import type { RunServices } from './types.js';
import type { UserInputQuestion } from './user-input.js';

const nativeApprovals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);

function approvalChanges(value: unknown) {
  if (!Array.isArray(value)) return value;
  let budget = 512 * 1024;
  return value.slice(0, 100).map((change) => {
    if (!change || typeof change !== 'object') return change;
    const original = change as Record<string, unknown>;
    const diff = typeof original.diff === 'string' ? original.diff : '';
    const available = Math.max(0, budget);
    const result = { ...original, diff: diff.slice(0, available), ...(diff.length > available ? { truncated: true } : {}) };
    budget -= diff.length;
    return result;
  });
}

function usesRemoteShell(command: unknown, cwd: string, root: string) {
  if (typeof command !== 'string') return false;
  if (command.includes(path.join(root, '.bin', 'remote-shell'))) return true;
  return path.resolve(root, cwd) === path.resolve(root)
    && /(?:^|[\s'"`;|&()])(?:\.\/)?\.bin\/remote-shell(?=$|[\s'"`;|&()])/.test(command);
}

export function codexPermissions(services: RunServices) {
  const mode = getPermissionMode(services.context.session);
  return {
    approvalPolicy: mode === 'full-access' ? 'never' : 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox: mode === 'full-access' ? 'danger-full-access' : 'workspace-write',
    sandboxPolicy: mode === 'full-access' ? { type: 'dangerFullAccess' } : {
      type: 'workspaceWrite', writableRoots: [services.context.project.local_path],
      networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    },
  };
}

export function createCodexRequests(
  services: RunServices,
  signal: AbortSignal,
  send: (message: RpcMessage) => void,
  isRunning: () => boolean,
) {
  const items = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, AbortController>();
  const canReply = (key: string, controller: AbortController) => {
    if (pending.get(key) !== controller) return false;
    pending.delete(key);
    return !signal.aborted && !controller.signal.aborted && isRunning();
  };

  return {
    record(item: Record<string, unknown>) {
      if (typeof item.id === 'string' && ['fileChange', 'commandExecution'].includes(String(item.type))) {
        items.set(item.id, { command: item.command, cwd: item.cwd, changes: approvalChanges(item.changes) });
      }
    },
    forget(itemId: string) {
      items.delete(itemId);
    },
    resolved(requestId: unknown) {
      if (requestId === undefined || requestId === null) return;
      const key = String(requestId);
      pending.get(key)?.abort();
      pending.delete(key);
    },
    close() {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      items.clear();
    },
    async handle(message: RpcMessage) {
      if (message.id === undefined || !message.method) return false;
      if (message.method === 'item/tool/requestUserInput') {
        const key = String(message.id);
        if (pending.has(key)) return true;
        const controller = new AbortController();
        pending.set(key, controller);
        try {
          const questions = message.params?.questions as UserInputQuestion[];
          if (!Array.isArray(questions)) throw new Error('原生问题列表无效');
          const answers = await services.ask(questions, controller.signal);
          if (canReply(key, controller)) send({ id: message.id, result: {
            answers: Object.fromEntries(Object.entries(answers ?? {}).map(([id, values]) => [id, { answers: values }])),
          } });
        } catch (error) {
          if (canReply(key, controller)) send({ id: message.id,
            error: { code: -32602, message: error instanceof Error ? error.message : '问题处理失败' } });
        } finally {
          if (pending.get(key) === controller) pending.delete(key);
          controller.abort();
        }
        return true;
      }
      if (!nativeApprovals.has(message.method)) return false;
      const key = String(message.id);
      if (pending.has(key)) return true;
      const controller = new AbortController();
      pending.set(key, controller);
      const params = message.params ?? {};
      const fileChange = message.method === 'item/fileChange/requestApproval';
      const itemId = String(params.itemId ?? params.callId ?? '');
      const item = items.get(itemId);
      const command = Array.isArray(params.command) ? params.command.join(' ') : params.command ?? item?.command;
      const root = services.context.project.local_path;
      const cwd = typeof params.cwd === 'string' ? params.cwd : typeof item?.cwd === 'string' ? item.cwd : root;
      const remote = services.context.project.execution_mode !== 'local' && usesRemoteShell(command, cwd, root);
      try {
        if (signal.aborted || !isRunning()) return true;
        if (remote) await services.verifyShell();
        const result = await services.approve(fileChange ? 'apply_patch' : 'shell', {
          native: true, itemId, reason: params.reason,
          ...(fileChange ? { changes: item?.changes ?? params.fileChanges, grantRoot: params.grantRoot } : {
            command, cwd,
            execution: remote ? 'remote' : 'local', commandActions: params.commandActions,
            networkApprovalContext: params.networkApprovalContext,
          }),
        }, controller.signal);
        if (remote && result.decision === 'allow' && !signal.aborted && !controller.signal.aborted) await services.verifyShell();
        if (canReply(key, controller)) send({ id: message.id, result: { decision: result.decision === 'allow' ? 'accept' : 'decline' } });
      } catch (error) {
        if (canReply(key, controller)) send({ id: message.id, result: { decision: 'decline' } });
      } finally {
        if (pending.get(key) === controller) pending.delete(key);
        controller.abort();
      }
      return true;
    },
  };
}
