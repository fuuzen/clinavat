import type { Config } from './config.js';
import type { Store } from './database.js';
import type { EventBus } from './events.js';
import type { SshManager } from './runtime/ssh.js';
import type { WorkspaceManager } from './runtime/workspace.js';
import type { AgentManager } from './agent/manager.js';
import type { AgentConfig } from './agent/types.js';
import type { ConnectionRegistry } from './connections.js';
import type { ConversationStore } from './conversation.js';
import { HttpError, type Host, type Project, type Session } from './models.js';

export interface Context {
  config: Config & AgentConfig; store: Store; events: EventBus; ssh: SshManager;
  workspaces: WorkspaceManager; agents: AgentManager;
  connections: ConnectionRegistry;
  turns: ConversationStore;
}
const activeResources = new WeakMap<Context, Set<string>>();
const sharedResources = new WeakMap<Context, Map<string, number>>();

export async function withResourceLocks<T>(context: Context, keys: string[], operation: () => Promise<T> | T, sharedKeys: string[] = []): Promise<T> {
  const resources = activeResources.get(context) ?? new Set<string>();
  const readers = sharedResources.get(context) ?? new Map<string, number>();
  if (keys.some(key => resources.has(key) || readers.has(key)) || sharedKeys.some(key => resources.has(key))) {
    throw new HttpError(409, '资源正在执行其他操作，请稍后重试');
  }
  activeResources.set(context, resources);
  sharedResources.set(context, readers);
  for (const key of keys) resources.add(key);
  for (const key of sharedKeys) readers.set(key, (readers.get(key) ?? 0) + 1);
  try { return await operation(); }
  finally {
    for (const key of keys) resources.delete(key);
    for (const key of sharedKeys) {
      const count = (readers.get(key) ?? 1) - 1;
      if (count) readers.set(key, count); else readers.delete(key);
    }
  }
}
export function owned<T>(store: Store, table: 'dev_hosts' | 'projects' | 'sessions', id: string, userId: string): T {
  const row = store.get<T>(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, id, userId);
  if (!row) throw new HttpError(404, '资源不存在');
  return row;
}
export function hostFor(context: Context, id: string, userId: string): Host {
  const host = owned<Host>(context.store, 'dev_hosts', id, userId);
  if (host.kind === 'local' && !context.store.get("SELECT id FROM users WHERE id=? AND role='admin'", userId)) {
    throw new HttpError(403, '仅管理员可使用本机开发机');
  }
  return host;
}
export function projectFor(context: Context, id: string, userId: string): Project {
  const project = owned<Project>(context.store, 'projects', id, userId);
  hostFor(context, project.dev_host_id, userId);
  return project;
}
export function sessionFor(context: Context, id: string, userId: string): Session {
  const session = owned<Session>(context.store, 'sessions', id, userId);
  projectFor(context, session.project_id, userId);
  return session;
}
export function assertProjectIdle(context: Context, projectId: string) {
  if (context.agents.isProjectBusy(projectId) || context.config.credentials.isProjectBusy(projectId)
    || context.store.get("SELECT id FROM sessions WHERE project_id=? AND status IN ('running','waiting','pausing','paused')", projectId)) {
    throw new HttpError(409, '项目中的会话正在运行，请先停止会话');
  }
}
