import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
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
import { AgentManager } from './agent/manager.js';
import { resourceRoutes } from './routes/resources.js';
import { sessionRoutes } from './routes/sessions.js';
import { agentModelRoutes } from './routes/agent-models.js';
import { adminRoutes } from './routes/admin.js';
import type { Host, Session } from './models.js';

async function binaryAvailable(binary: string) {
  const paths = isAbsolute(binary) ? [binary] : (process.env.PATH ?? '').split(':').map(path => join(path, binary));
  for (const path of paths) {
    try { await access(path, constants.X_OK); return true; } catch { /* Try the next executable directory. */ }
  }
  return false;
}

const app = Fastify({
  logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] },
  bodyLimit: 1024 * 1024, requestTimeout: 120000, trustProxy: false,
});
const store = new Store(config.dataDir);
const connections = new ConnectionRegistry(store);
const events = new EventBus(store, config.approvalTimeoutMs);
const turns = new ConversationStore(store, turn => {
  const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', turn.session_id);
  if (session) events.broadcast(session.user_id, { type: 'turn', sessionId: turn.session_id, payload: turn });
});
const ssh = new SshManager(config);
const workspaces = new WorkspaceManager(config, ssh);
for (const host of store.all<Host>('SELECT * FROM dev_hosts')) {
  try { await ssh.addHost(host.user_id, host); }
  catch (error) { app.log.error({ err: error, hostId: host.id }, '无法恢复开发机运行时密钥'); }
}
const agents = new AgentManager(config, {
  event(event) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', event.sessionId);
    if (session) {
      if (event.type === 'turn-state') {
        const payload = event.payload as { status: 'completed' | 'interrupted' | 'error'; turnId?: string };
        turns.finish(event.sessionId, payload.status, payload.turnId);
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
  updateSession(sessionId, fields) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) return;
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
});

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
await app.register(websocket, { options: { maxPayload: 65536 } });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') });
  const problem = error as Error & { statusCode?: number; code?: string };
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
registerAuth(app, store, config, ssh, connections);
events.register(app, connections);
const context = { config, store, events, ssh, workspaces, agents, connections, turns };
resourceRoutes(app, context);
sessionRoutes(app, context);
agentModelRoutes(app, context);
adminRoutes(app, context);
app.get('/api/health', async () => ({
  status: 'ok', version: '0.1.0', runtime: {
    claude: await binaryAvailable(config.claudeBinary), codex: await binaryAvailable(config.codexBinary),
    mutagen: await binaryAvailable(config.mutagenBinary), ssh: await binaryAvailable(config.sshBinary),
  },
}));
app.addHook('preClose', async () => { connections.close(); events.close(); await agents.close(); });
app.addHook('onClose', async () => { await ssh.close(); store.close(); });
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void app.close().catch(error => { app.log.error(error); process.exitCode = 1; });
});
try { await app.listen({ host: config.host, port: config.port }); }
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
