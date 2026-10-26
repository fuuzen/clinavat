import type { Config } from './config.js';
import type { Store } from './database.js';
import type { EventBus } from './events.js';
import type { SshManager } from './runtime/ssh.js';
import type { WorkspaceManager } from './runtime/workspace.js';
import type { AgentManager } from './agent/manager.js';
import type { ConnectionRegistry } from './connections.js';
import type { ConversationStore } from './conversation.js';
import { HttpError, type Host, type Project, type Session } from './models.js';

export interface Context {
  config: Config; store: Store; events: EventBus; ssh: SshManager;
  workspaces: WorkspaceManager; agents: AgentManager;
  connections: ConnectionRegistry;
  turns: ConversationStore;
}
const activeResources = new WeakMap<Context, Set<string>>();

export async function withResourceLocks<T>(context: Context, keys: string[], operation: () => Promise<T> | T): Promise<T> {
  const resources = activeResources.get(context) ?? new Set<string>();
  if (keys.some(key => resources.has(key))) throw new HttpError(409, '资源正在执行其他操作，请稍后重试');
  activeResources.set(context, resources);
  for (const key of keys) resources.add(key);
  try { return await operation(); }
  finally { for (const key of keys) resources.delete(key); }
}
export function owned<T>(store: Store, table: 'dev_hosts' | 'projects' | 'sessions', id: string, userId: string): T {
  const row = store.get<T>(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, id, userId);
  if (!row) throw new HttpError(404, '资源不存在');
  return row;
}
export const hostFor = (context: Context, id: string, userId: string) => owned<Host>(context.store, 'dev_hosts', id, userId);
export const projectFor = (context: Context, id: string, userId: string) => owned<Project>(context.store, 'projects', id, userId);
export const sessionFor = (context: Context, id: string, userId: string) => owned<Session>(context.store, 'sessions', id, userId);
export function assertProjectIdle(context: Context, projectId: string) {
  if (context.agents.isProjectBusy(projectId) || context.store.get("SELECT id FROM sessions WHERE project_id=? AND status IN ('running','waiting')", projectId)) {
    throw new HttpError(409, '项目中的会话正在运行，请先停止会话');
  }
}
