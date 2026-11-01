import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './config.js';
import { Store } from './database.js';
import { registerAuth } from './auth.js';
import { EventBus } from './events.js';
import { ConversationStore } from './conversation.js';
import { ConnectionRegistry } from './connections.js';
import { SshManager } from './runtime/ssh.js';
import { WorkspaceManager } from './runtime/workspace.js';
import { migrateWorkspaces, saveWorkspaceMigration } from './runtime/workspace-migration.js';
import { AgentManager } from './agent/manager.js';
import { recoverSessionRuns } from './agent/recovery.js';
import { resourceRoutes } from './routes/resources.js';
import { sessionRoutes } from './routes/sessions.js';
import { agentModelRoutes } from './routes/agent-models.js';
import { completionRoutes } from './routes/completions.js';
import { adminRoutes } from './routes/admin.js';
import { siteAccessRoutes } from './routes/site-access.js';
import { siteSettingsRoutes } from './routes/site-settings.js';
import { gatewayRoutes } from './routes/gateway.js';
import { GatewayClient } from './gateway/client.js';
import { GatewayService } from './gateway/service.js';
import { SiteAccess } from './site-access.js';
import { SiteSettingsService } from './site-settings.js';
import type { Host, Project, Session } from './models.js';
import { AccountCredentials } from './accounts/credentials.js';
import { SlotUsage } from './accounts/usage.js';
import { migrateAccountHomes } from './accounts/migration.js';
import { recoverLegacyCredentials } from './accounts/credential-recovery.js';
import { recoverConversationCredentials } from './accounts/credential-recovery-v2.js';
import { migrateSlotSchema } from './accounts/slot-schema.js';
import { assertAccountProcessesStopped } from './accounts/migration-state.js';
import { ProcessExecutionHost } from './execution/process-host.js';

const app = Fastify({
  logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] },
  bodyLimit: 1024 * 1024, requestTimeout: 120000, trustProxy: false,
});
const store = new Store(config.dataDir);
const siteAccess = new SiteAccess(store, config);
await assertAccountProcessesStopped(config.dataDir, store.all<{ home_dir: string }>('SELECT home_dir FROM account_slots').map(slot => slot.home_dir));
await migrateAccountHomes(config.dataDir, store);
await recoverLegacyCredentials(config.dataDir, store);
await migrateSlotSchema(config.dataDir, store);
await recoverConversationCredentials(config.dataDir, store);
let onSlotActivity: (slotId: string) => void = () => undefined;
const execution = new ProcessExecutionHost(config);
const credentials = new AccountCredentials(config.dataDir, store, execution, slotId => onSlotActivity(slotId));
await credentials.recover();
const connections = new ConnectionRegistry(store);
const events = new EventBus(store, config.approvalTimeoutMs);
const slotRecipients = (slotId: string) => store.all<{ user_id: string }>(`SELECT user_id FROM slot_user_access WHERE slot_id=?
    UNION SELECT id AS user_id FROM users WHERE role='admin'`, slotId).map(row => row.user_id);
const usage = new SlotUsage(config, credentials, slotId => {
  const payload = { slotId, usage: usage.view(slotId) };
  for (const userId of slotRecipients(slotId)) events.broadcast(userId, { type: 'slot-usage', payload });
});
await usage.init();
const agentConfig = { ...config, credentials, usage, execution };
onSlotActivity = slotId => {
  for (const userId of slotRecipients(slotId)) events.broadcast(userId, { type: 'slot', payload: { id: slotId } });
};
const turns = new ConversationStore(store, turn => {
  const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', turn.session_id);
  if (session) events.broadcast(session.user_id, { type: 'turn', sessionId: turn.session_id, payload: turn });
});
const ssh = new SshManager(config);
const workspaces = new WorkspaceManager(config, ssh, execution);
for (const host of store.all<Host>('SELECT * FROM dev_hosts')) {
  if (host.kind === 'local') continue;
  try { await ssh.addHost(host.user_id, host); }
  catch (error) { app.log.error({ err: error, hostId: host.id }, '无法恢复开发机运行时密钥'); }
}
const migrations = await migrateWorkspaces(config, store, ssh);
for (const migration of migrations) {
  if (migration.error) {
    app.log.error({ projectId: migration.projectId, error: migration.error }, '工作区迁移未完成，保留原目录');
    continue;
  }
  if (migration.phase !== 'complete' || migration.restored || migration.wasPaused) continue;
  const project = store.get<Project>('SELECT * FROM projects WHERE id=?', migration.projectId)!;
  const host = store.get<Host>('SELECT * FROM dev_hosts WHERE id=?', project.dev_host_id)!;
  try {
    await workspaces.create(project.user_id, host, project);
    const health = await workspaces.status(project);
    store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?', health.status, project.execution_mode, project.id);
    migration.reusable = false;
    migration.restored = true;
    await saveWorkspaceMigration(config, migration);
  } catch (error) {
    store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
    app.log.error({ err: error, projectId: project.id }, '工作区已迁移，恢复远端路径或同步失败，可在项目中重试');
  }
}
for (const project of store.all<Project>("SELECT * FROM projects WHERE sync_status='WATCHING' AND execution_mode IS NOT NULL")) {
  const host = store.get<Host>('SELECT * FROM dev_hosts WHERE id=?', project.dev_host_id);
  if (!host) continue;
  try { await workspaces.refreshExecutor(project, host); }
  catch (error) {
    store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
    app.log.error({ err: error, projectId: project.id }, '无法刷新项目远程执行器');
  }
}
const agents = new AgentManager(agentConfig, {
  event(event) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', event.sessionId);
    if (session) {
      if (event.type === 'turn-state') {
        const payload = event.payload as { status: 'running' | 'pausing' | 'paused' | 'completed' | 'interrupted' | 'error'; turnId?: string };
        if (payload.status === 'running' || payload.status === 'pausing' || payload.status === 'paused') {
          turns.setState(event.sessionId, payload.status, payload.turnId);
        } else turns.finish(event.sessionId, payload.status, payload.turnId);
        return;
      }
      if (event.type === 'tool' || event.type === 'activity') {
        if (!turns.record(event.sessionId, event.type, event.payload)) events.broadcast(session.user_id, event);
        return;
      }
      if (event.type === 'done') events.cancelSession(session.user_id, event.sessionId);
      events.emit(session.user_id, event);
    }
  },
  saveMessage(sessionId, role, content) {
    if (!content.trim()) return;
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) return;
    const id = randomUUID();
    store.run('INSERT INTO messages(id,session_id,role,content) VALUES(?,?,?,?)', id, sessionId, role, content);
    if (role === 'assistant') turns.attachAnswer(sessionId, id);
    events.emit(session.user_id, { type: 'message', sessionId, payload: store.get('SELECT * FROM messages WHERE id=?', id) });
  },
  async updateSession(sessionId, fields) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) return;
    if (fields.jsonl_file_path) fields = { ...fields, jsonl_file_path: await realpath(fields.jsonl_file_path) };
    for (const key of ['native_session_id', 'status', 'jsonl_file_path'] as const) {
      if (fields[key] !== undefined) store.run(`UPDATE sessions SET ${key}=?,updated_at=datetime('now') WHERE id=?`, fields[key]!, sessionId);
    }
    events.emit(session.user_id, { type: 'session', sessionId, payload: store.get('SELECT * FROM sessions WHERE id=?', sessionId) });
  },
  approval(request) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', request.sessionId);
    if (!session) return Promise.resolve({ decision: 'deny', reason: '会话不存在' });
    return events.requestApproval(session.user_id, request);
  },
  async flushWorkspace(sessionId) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    const project = session && store.get<Project>('SELECT * FROM projects WHERE id=?', session.project_id);
    if (!project) throw new Error('项目不存在，无法同步智能体修改');
    try { await workspaces.flush(project); }
    catch (error) {
      store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
      events.emit(session.user_id, { type: 'project', payload: { id: project.id, sync_status: 'ERROR' } });
      throw error;
    }
  },
});

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
await app.register(websocket, { options: { maxPayload: 65536 } });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') });
  const problem = error as Error & { statusCode?: number; code?: string };
  if (['CLINAVAT_RELEASE_IN_PROGRESS', 'CC_POOL_RELEASE_IN_PROGRESS'].some(code => problem.message.includes(code))) {
    return reply.code(503).send({ error: '系统正在更新，请稍后重试。' });
  }
  if (problem.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ error: '资源已存在或已绑定' });
  const statusCode = problem.statusCode && problem.statusCode >= 400 ? problem.statusCode : 500;
  if (statusCode >= 500) app.log.error(problem);
  return reply.code(statusCode).send({ error: statusCode === 500 ? '操作失败，请查看服务日志' : problem.message });
});
app.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Cache-Control', 'no-store');
});
registerAuth(app, store, config, ssh, connections, siteAccess);
events.register(app, connections);
const context = { config: agentConfig, store, events, ssh, workspaces, agents, connections, turns };
resourceRoutes(app, context);
sessionRoutes(app, context);
agentModelRoutes(app, context);
completionRoutes(app, context);
adminRoutes(app, context);
siteAccessRoutes(app, siteAccess);
siteSettingsRoutes(app, new SiteSettingsService(store), store, events);
gatewayRoutes(app, new GatewayService(new GatewayClient(config, ssh.keys), store));
app.get('/api/health', async () => {
  const { kind, ...runtime } = await execution.health();
  return { status: 'ok', version: '0.1.0', execution: kind, runtime };
});
let recovery: ReturnType<typeof recoverSessionRuns> | undefined;
app.addHook('preClose', async () => {
  const recovered = recovery?.close();
  connections.close();
  events.close();
  await agents.close();
  await recovered;
});
app.addHook('onClose', async () => { await ssh.close(); store.close(); });
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void app.close().catch(error => { app.log.error(error); process.exitCode = 1; });
});
try {
  await app.listen({ host: config.host, port: config.port });
  recovery = recoverSessionRuns(context, error => app.log.error({ err: error }, '原生会话迁移恢复失败'));
}
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
