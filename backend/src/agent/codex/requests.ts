import path from 'node:path';
import { vmProjectRoot, vmWorkingDirectory } from '../environment.js';
import { getPermissionMode } from '../permissions.js';
import type { RpcMessage } from '../rpc.js';
import {
  assertWritable, isClientDirect, isClientMirrored, isSuperAgent, nativeReadsEnabled,
} from '../orchestration-tools.js';
import { directDeclineHint, validateCodexMirroredFileChanges } from './client-mode.js';
import type { RunServices } from '../types.js';
import { unansweredNotice, type UserInputQuestion } from '../user-input.js';

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

function usesRemoteShell(command: unknown, cwd: string, services: RunServices) {
  if (typeof command !== 'string') return false;
  const { project } = services.context;
  const vmRoot = vmProjectRoot(services.context, services.config.workspaceDir);
  if (project.execution_mode === 'local') return !!project.host_shell && command.includes(project.host_shell);
  if (command.includes(path.posix.join(vmRoot, '.bin', 'remote-shell')) || command.includes(path.join(project.local_path, '.bin', 'remote-shell'))) {
    return true;
  }
  const resolved = path.posix.resolve(vmRoot, cwd);
  return (resolved === path.posix.resolve(vmRoot) || path.resolve(project.local_path, cwd) === path.resolve(project.local_path))
    && /(?:^|[\s'"`;|&()])(?:\.\/)?\.bin\/remote-shell(?=$|[\s'"`;|&()])/.test(command);
}

export function codexPermissions(services: RunServices) {
  const mode = getPermissionMode(services.context.session);
  // Super Agent and client-direct runs keep Codex's read-only sandbox; client-direct edits/commands go via clinavat.client_*.
  if (isSuperAgent(services.context) || isClientDirect(services.context)) {
    return {
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly' },
    };
  }
  // Codex cannot turn off apply_patch, and its read-only sandbox breaks remote-shell, which writes its lock in the
  // project. A read-only child instead asks for everything Codex does not know to be safe, and the Hub declines file changes.
  const readOnly = services.context.session.agent_access === 'read';
  const vmRoot = vmProjectRoot(services.context, services.config.workspaceDir);
  const vmCwd = vmWorkingDirectory(services.context, services.config.workspaceDir);
  return {
    approvalPolicy: readOnly ? 'untrusted' : mode === 'full-access' ? 'never' : 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox: mode === 'full-access' ? 'danger-full-access' : 'workspace-write',
    sandboxPolicy: mode === 'full-access' ? { type: 'dangerFullAccess' } : {
      // A child confined to a directory may still need .bin, where remote-shell keeps its lock.
      type: 'workspaceWrite', writableRoots: services.context.session.agent_directory
        ? [vmCwd, path.posix.join(vmRoot, '.bin')] : [vmRoot],
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
      if (!nativeReadsEnabled(services.context) && ['item/commandExecution/requestApproval', 'execCommandApproval'].includes(message.method)) {
        if (isClientDirect(services.context)) {
          services.event('activity', { id: `codex-direct-deny:${String(message.id)}`, kind: 'notice', text: directDeclineHint(false) });
        }
        if (!signal.aborted && isRunning()) {
          send({ id: message.id, result: { decision: message.method === 'execCommandApproval' ? 'denied' : 'decline' } });
        }
        return true;
      }
      if (message.method === 'item/tool/requestUserInput') {
        const key = String(message.id);
        if (pending.has(key)) return true;
        const controller = new AbortController();
        pending.set(key, controller);
        try {
          const questions = message.params?.questions as UserInputQuestion[];
          if (!Array.isArray(questions)) throw new Error('原生问题列表无效');
          const outcome = await services.ask(questions, controller.signal);
          // Codex has no way to decline a question; a kept one is answered with the request to end the turn.
          const answers = outcome.status === 'answered' ? outcome.answers : outcome.status === 'deferred'
            ? Object.fromEntries(questions.map(question => [question.id, [unansweredNotice(outcome)]])) : {};
          if (canReply(key, controller)) send({ id: message.id, result: {
            answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])),
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
      const root = vmProjectRoot(services.context, services.config.workspaceDir);
      const cwd = typeof params.cwd === 'string' ? params.cwd : typeof item?.cwd === 'string' ? item.cwd : root;
      const remote = usesRemoteShell(command, cwd, services);
      try {
        if (signal.aborted || !isRunning()) return true;
        if (isClientDirect(services.context)) {
          services.event('activity', { id: `codex-direct-deny:${itemId || key}`, kind: 'notice', text: directDeclineHint(fileChange) });
          if (canReply(key, controller)) send({ id: message.id, result: { decision: 'decline' } });
          return true;
        }
        const changes = Array.isArray(item?.changes) ? item.changes as { path?: unknown }[]
          : Array.isArray(params.fileChanges) ? params.fileChanges as { path?: unknown }[] : [];
        if (fileChange && isClientMirrored(services.context)) {
          const mirroredError = await validateCodexMirroredFileChanges(services.context, cwd, changes, services.config.workspaceDir);
          if (mirroredError) {
            services.event('activity', { id: `codex-mirror-deny:${itemId || key}`, kind: 'notice', text: mirroredError });
            if (canReply(key, controller)) send({ id: message.id, result: { decision: 'decline' } });
            return true;
          }
        }
        const outside = fileChange && (await Promise.all(changes.map(change => typeof change.path === 'string'
          ? assertWritable(services.context, path.posix.resolve(cwd, change.path)).then(() => false, () => true) : false))).some(Boolean);
        if (isSuperAgent(services.context)) {
          if (canReply(key, controller)) send({ id: message.id, result: { decision: 'decline' } });
          return true;
        }
        if (fileChange && (services.context.session.agent_access === 'read' || outside)) {
          if (canReply(key, controller)) send({ id: message.id, result: { decision: 'decline' } });
          return true;
        }
        if (remote) await services.verifyShell();
        // Approved commands of an untrusted thread leave the sandbox, which full access already allows.
        const unattended = !fileChange && services.context.session.agent_access === 'read' && getPermissionMode(services.context.session) === 'full-access';
        const result = unattended ? { decision: 'allow' as const } : await services.approve(fileChange ? 'apply_patch' : 'shell', {
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
