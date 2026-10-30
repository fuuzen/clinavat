import { randomUUID } from 'node:crypto';
import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateJson } from '../accounts/credential-files.js';
import { slotForUser } from '../accounts/access.js';
import { projectFor, sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError, type Project } from '../models.js';
import { validateAgentSelection } from './model-catalog.js';
import { validatePermissionMode } from './permissions.js';
import { validateSessionSettings } from './session-settings.js';

const recoverySchema = z.object({
  version: z.literal(1),
  sessions: z.array(z.object({
    sessionId: z.uuid(), userId: z.uuid(), nativeSessionId: z.uuid(),
    slotId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    userMessageId: z.uuid(),
  }).strict()).max(20).refine(entries => new Set(entries.map(entry => entry.sessionId)).size === entries.length, '恢复会话不可重复'),
}).strict();
type RecoverySession = z.infer<typeof recoverySchema>['sessions'][number];

async function readManifest(file: string) {
  const content = await readPrivateJson(file);
  if (content === undefined) return undefined;
  if (((await lstat(file)).mode & 0o777) !== 0o600) throw new Error('会话恢复清单权限必须为 0600');
  return recoverySchema.parse(JSON.parse(content));
}

export function recoverSessionRuns(context: Context, report: (error: Error) => void): { close(): Promise<void> } {
  let closed = false;
  let cancelWait: (() => void) | undefined;
  const waitForRetry = () => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); cancelWait = undefined; resolve(); };
    const timer = setTimeout(finish, 500);
    timer.unref();
    cancelWait = finish;
  });

  function recordWorkspaceHealth(project: Project, status: string): void {
    if (project.sync_status === status) return;
    context.store.run('UPDATE projects SET sync_status=? WHERE id=?', status, project.id);
    project.sync_status = status;
    context.events.emit(project.user_id, { type: 'project', payload: { id: project.id, sync_status: status } });
  }

  async function waitForWorkspace(project: Project, deadline: number): Promise<boolean> {
    while (!closed) {
      const health = await context.workspaces.status(project);
      if (closed) return false;
      recordWorkspaceHealth(project, health.status);
      if (health.status === (project.execution_mode === 'local' ? 'LOCAL' : 'WATCHING')) return true;
      if (health.status !== 'SYNCING') {
        throw new HttpError(409, `项目执行环境无法恢复会话（${health.status}）：\n${health.detail}`);
      }
      if (Date.now() >= deadline) throw new HttpError(504, `等待项目同步就绪超时：\n${health.detail}`);
      await waitForRetry();
    }
    return false;
  }

  async function flushWorkspace(project: Project, deadline: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3 && !closed; attempt++) {
      try { await context.workspaces.flush(project); return !closed; }
      catch (error) {
        if (closed) return false;
        const health = await context.workspaces.status(project);
        if (closed) return false;
        recordWorkspaceHealth(project, health.status);
        if (health.status === 'SYNCING' && attempt < 2) {
          if (!await waitForWorkspace(project, deadline)) return false;
          continue;
        }
        if (health.status === 'ERROR' || health.status === 'PAUSED') {
          throw new Error(`项目同步无法恢复会话（${health.status}）：\n${health.detail}`, { cause: error });
        }
        throw error;
      }
    }
    return false;
  }

  async function restore(entry: RecoverySession): Promise<void> {
    const original = sessionFor(context, entry.sessionId, entry.userId);
    await withResourceLocks(context, [`session:${entry.sessionId}`], async () => {
      if (closed) return;
      const { store, config, agents, turns, events } = context;
      const session = sessionFor(context, entry.sessionId, entry.userId);
      const project = projectFor(context, session.project_id, entry.userId);
      if (session.engine !== 'claude' || session.slot_id !== entry.slotId || session.native_session_id !== entry.nativeSessionId) {
        throw new HttpError(409, '会话的引擎、授权槽位或原生会话已发生变化');
      }
      if (!store.get("SELECT id FROM messages WHERE id=? AND session_id=? AND role='user'", entry.userMessageId, session.id)) {
        throw new HttpError(409, '恢复消息不属于当前对话');
      }
      if (agents.isBusy(session.id) || config.credentials.isSessionBusy(session.id)
        || ['running', 'waiting', 'pausing', 'paused'].includes(session.status)) {
        throw new HttpError(409, '当前对话仍在运行或回收状态');
      }
      const workspaceDeadline = Date.now() + 90_000;
      if (!await waitForWorkspace(project, workspaceDeadline)) return;
      const slot = slotForUser(store, entry.slotId, entry.userId, 'claude');
      const permissionMode = validatePermissionMode('claude', session.permission_mode);
      const { agentMode, rolePreset } = validateSessionSettings('claude', session.agent_mode, session.role_preset);
      const runtime = {
        runtime_home: slot.home_dir, runtime_kind: 'conversation' as const,
        user: { id: entry.userId }, project, slot,
        session: { ...session, permission_mode: permissionMode, agent_mode: agentMode, role_preset: rolePreset, resume_interrupted: true },
      };
      const release = await config.credentials.acquire(runtime);
      try {
        if (closed) return;
        await validateAgentSelection(config, runtime, { model: session.model, reasoningEffort: session.reasoning_effort });
        if (closed) return;
        if (!await flushWorkspace(project, workspaceDeadline)) return;
        const turnId = randomUUID();
        try {
          store.transaction(() => {
            store.run("UPDATE sessions SET status='running',updated_at=datetime('now') WHERE id=?", session.id);
            turns.start(session.id, entry.userMessageId, { slotId: slot.id, credentialRevision: slot.credential_revision }, turnId);
          });
          await agents.start({ ...runtime, session: { ...runtime.session, turn_id: turnId } }, '');
        } catch (error) {
          turns.finish(session.id, 'error', turnId);
          store.run("UPDATE sessions SET status='error',updated_at=datetime('now') WHERE id=?", session.id);
          events.emit(entry.userId, { type: 'error', sessionId: session.id,
            payload: { message: error instanceof Error ? error.message : '会话恢复失败' } });
          throw error;
        }
      } finally { await release(); }
    }, [`project:${original.project_id}`]);
  }

  async function recover(): Promise<void> {
    const file = join(context.config.dataDir, 'agent-runtime', 'session-recovery.json');
    if (await readManifest(file) === undefined || closed) return;
    while (!closed && context.store.get("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB 'clinavat_release_*' OR name GLOB 'cc_pool_release_*') LIMIT 1")) {
      await waitForRetry();
    }
    if (closed) return;
    const claimed = join(context.config.dataDir, 'agent-runtime', `session-recovery.${Date.now()}.claimed.json`);
    await rename(file, claimed);
    if (closed) return;
    const manifest = await readManifest(claimed);
    if (!manifest) throw new Error('已领取的会话恢复清单不存在');
    for (const entry of manifest.sessions) {
      if (closed) return;
      try { await restore(entry); }
      catch (error) { report(new Error(`会话 ${entry.sessionId} 恢复失败`, { cause: error })); }
    }
  }

  const completion = recover().catch(error => report(error instanceof Error ? error : new Error(String(error))));
  return { close() { closed = true; cancelWait?.(); return completion; } };
}
