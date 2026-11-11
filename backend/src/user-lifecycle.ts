import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { updateSlot } from './accounts/assignments.js';
import { withResourceLocks, type Context } from './context.js';
import { HttpError, type Host, type Project, type User } from './models.js';

/** Ends the user's sign-ins and the event streams and terminals opened with them; `keep` spares the caller's own. */
export function signOut(context: Context, userId: string, keep?: string): void {
  const sessions = context.store.all<{ token_hash: string }>('SELECT token_hash FROM auth_sessions WHERE user_id=?', userId)
    .filter(session => session.token_hash !== keep);
  for (const session of sessions) {
    context.store.run('DELETE FROM auth_sessions WHERE token_hash=?', session.token_hash);
    context.connections.revoke(session.token_hash);
  }
}

function userFor(context: Context, userId: string): User {
  const user = context.store.get<User>('SELECT * FROM users WHERE id=?', userId);
  if (!user) throw new HttpError(404, '用户不存在');
  return user;
}

/** Suspending or deleting must leave the site with someone who can still administer it. */
function assertRemovable(context: Context, user: User, actorId: string): void {
  if (user.id === actorId) throw new HttpError(409, '不能停用或删除自己的账号');
  if (user.role === 'admin' && !context.store.get("SELECT id FROM users WHERE role='admin' AND suspended_at IS NULL AND id<>?", user.id)) {
    throw new HttpError(409, '至少需要保留一位可用的管理员');
  }
}

/** Runs with every project and host of the user locked, so no request can start new work on them meanwhile. */
function withUserLocks<T>(context: Context, userId: string, operation: () => Promise<T>): Promise<T> {
  const projects = context.store.all<{ id: string }>('SELECT id FROM projects WHERE user_id=?', userId);
  const hosts = context.store.all<{ id: string }>('SELECT id FROM dev_hosts WHERE user_id=?', userId);
  return withResourceLocks(context, [`user:${userId}`, `user-hosts:${userId}`,
    ...projects.map(project => `project:${project.id}`), ...hosts.map(host => `host:${host.id}`)], operation);
}

/**
 * Takes back everything a user holds: running CLIs, slot assignments, project sync, SSH connections and their
 * workspace machine. Suspension keeps every file so the user can come back; deletion removes mirrors and keys too.
 */
async function reclaim(context: Context, user: User, remove: boolean): Promise<void> {
  const { store, agents, config, ssh, workspaces, connections } = context;
  signOut(context, user.id);
  const sessions = store.all<{ id: string }>('SELECT id FROM sessions WHERE user_id=?', user.id).map(session => session.id);
  await Promise.all(sessions.filter(id => agents.isBusy(id)).map(id => agents.stop(id).catch(() => undefined)));
  await agents.reclaimWhere({ userId: user.id });
  for (const id of sessions) await config.credentials.retrySessionRelease(id).catch(() => undefined);
  if (agents.isUserBusy(user.id) || config.credentials.isUserBusy(user.id)) {
    throw new HttpError(409, '该用户的任务仍在结束，资源回收尚未完成，请稍后重试');
  }
  for (const { slot_id: slotId } of store.all<{ slot_id: string }>('SELECT slot_id FROM slot_user_access WHERE user_id=?', user.id)) {
    const others = store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=? AND user_id<>?', slotId, user.id);
    await updateSlot(context, slotId, { allowedUserIds: others.map(row => row.user_id) });
  }
  const projects = store.all<Project>('SELECT * FROM projects WHERE user_id=?', user.id);
  for (const project of projects) {
    connections.revokeResource(`project:${project.id}`);
    if (remove) await workspaces.remove(project, true);
    else if (project.execution_mode !== 'local') {
      await workspaces.pause(project);
      store.run("UPDATE projects SET sync_status='PAUSED' WHERE id=?", project.id);
    }
  }
  for (const host of store.all<Host>("SELECT * FROM dev_hosts WHERE user_id=? AND kind='ssh'", user.id)) {
    await (remove ? ssh.deleteHost(user.id, host) : ssh.disconnectHost(user.id, host));
  }
  store.run("UPDATE dev_hosts SET status='DISCONNECTED' WHERE user_id=? AND kind='ssh'", user.id);
  await workspaces.stopDaemon(user.id).catch(() => undefined);
  const userDirectory = join(config.dataDir, 'users', user.id);
  // Slot machines keep the last user's files mounted until the next user arrives.
  await config.execution.revoke(user.id, [join(userDirectory, 'engine-state'), join(userDirectory, '.ssh'),
    join(config.dataDir, 'run', 'keys', user.id), ...projects.map(project => project.local_path)]);
  await config.execution.retire('workspace', user.id, remove);
}

export async function suspendUser(context: Context, userId: string, actorId: string): Promise<void> {
  const user = userFor(context, userId);
  assertRemovable(context, user, actorId);
  // Marked first, so the user cannot sign in or act while the rest is taken back; a failed reclaim can be retried.
  context.store.run("UPDATE users SET suspended_at=COALESCE(suspended_at,datetime('now')) WHERE id=?", userId);
  await withUserLocks(context, userId, () => reclaim(context, user, false));
}

export function restoreUser(context: Context, userId: string): void {
  userFor(context, userId);
  context.store.run('UPDATE users SET suspended_at=NULL WHERE id=?', userId);
}

export async function deleteUser(context: Context, userId: string, actorId: string): Promise<void> {
  const { store, config } = context;
  const user = userFor(context, userId);
  assertRemovable(context, user, actorId);
  store.run("UPDATE users SET suspended_at=COALESCE(suspended_at,datetime('now')) WHERE id=?", userId);
  await withUserLocks(context, userId, async () => {
    await reclaim(context, user, true);
    await Promise.all([join(config.dataDir, 'users', userId), join(config.dataDir, 'run', 'keys', userId)]
      .map(path => rm(path, { recursive: true, force: true })));
    // Messages, turns, approvals and questions go with their sessions; slot access, sign-ins, defaults and
    // token usage go with the user.
    store.transaction(() => {
      store.run('DELETE FROM sessions WHERE user_id=?', userId);
      store.run('DELETE FROM approvals WHERE user_id=?', userId);
      store.run('DELETE FROM projects WHERE user_id=?', userId);
      store.run('DELETE FROM dev_hosts WHERE user_id=?', userId);
      store.run('DELETE FROM events WHERE user_id=?', userId);
      store.run('DELETE FROM users WHERE id=?', userId);
    });
  });
}
