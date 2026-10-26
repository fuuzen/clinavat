import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Context, assertProjectIdle, projectFor, sessionFor, withResourceLocks } from '../context.js';
import { HttpError, type Slot } from '../models.js';
import { serializeSlot, publicUser } from '../auth.js';
import { validateAgentSelection } from '../agent/model-catalog.js';

const identifier = z.object({ id: z.uuid() });
const selectionFields = {
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoningEffort: z.string().trim().min(1).max(32).nullable().optional(),
};
export function sessionRoutes(app: FastifyInstance, context: Context) {
  const { store, events, agents, ssh, workspaces, turns } = context;
  app.get('/api/overview', async request => {
    const key = await ssh.ensureUserKey(request.user.id);
    return {
      user: publicUser(request.user, key.publicKey), slot: serializeSlot(store.assignSlot(request.user.id)),
      hosts: store.all('SELECT * FROM dev_hosts WHERE user_id=? ORDER BY created_at', request.user.id),
      projects: store.all('SELECT * FROM projects WHERE user_id=? ORDER BY created_at', request.user.id),
      sessions: store.all('SELECT * FROM sessions WHERE user_id=? ORDER BY updated_at DESC', request.user.id),
    };
  });
  app.post('/api/sessions', async (request, reply) => {
    const input = z.object({ projectId: z.uuid(), engine: z.enum(['claude', 'codex']), title: z.string().trim().min(1).max(200).default('新对话'), ...selectionFields }).parse(request.body);
    return withResourceLocks(context, [`project:${input.projectId}`], async () => {
      const project = projectFor(context, input.projectId, request.user.id);
      const slot = store.assignSlot(request.user.id);
      if (!slot || slot.status !== 'ASSIGNED') throw new HttpError(409, '尚无可用的专属账号，请联系管理员分配槽位');
      if (!(JSON.parse(slot.cli_types) as string[]).includes(input.engine)) throw new HttpError(409, '专属槽位未配置该 CLI');
      const id = randomUUID();
      await validateAgentSelection(context.config, {
        user: request.user, project, slot: { ...slot, cli_types: JSON.parse(slot.cli_types) as string[] },
        session: { id, engine: input.engine, model: input.model ?? null, reasoning_effort: input.reasoningEffort ?? null },
      }, input);
      store.run('INSERT INTO sessions(id,project_id,user_id,engine,title,model,reasoning_effort) VALUES(?,?,?,?,?,?,?)',
        id, input.projectId, request.user.id, input.engine, input.title, input.model ?? null, input.reasoningEffort ?? null);
      return reply.code(201).send(sessionFor(context, id, request.user.id));
    });
  });
  app.patch('/api/sessions/:id', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    const { title } = z.object({ title: z.string().trim().min(1).max(200) }).parse(request.body);
    store.run('UPDATE sessions SET title=? WHERE id=?', title, id);
    return sessionFor(context, id, request.user.id);
  });
  app.delete('/api/sessions/:id', async request => {
    const { id } = identifier.parse(request.params);
    const session = sessionFor(context, id, request.user.id);
    return withResourceLocks(context, [`project:${session.project_id}`], () => {
      if (agents.isBusy(id) || ['running', 'waiting'].includes(session.status)) throw new HttpError(409, '请先停止会话');
      store.run('DELETE FROM sessions WHERE id=?', id);
      return { ok: true };
    });
  });
  app.get('/api/sessions/:id/messages', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    return store.all('SELECT * FROM messages WHERE session_id=? ORDER BY rowid', id);
  });
  app.get('/api/sessions/:id/turns', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    return turns.list(id);
  });
  app.post('/api/sessions/:id/messages', async request => {
    const { id } = identifier.parse(request.params);
    const input = z.object({ content: z.string().trim().min(1).max(100000), ...selectionFields }).parse(request.body);
    const { content } = input;
    const session = sessionFor(context, id, request.user.id);
    return withResourceLocks(context, [`project:${session.project_id}`], async () => {
      const project = projectFor(context, session.project_id, request.user.id);
      assertProjectIdle(context, project.id);
      const slot = store.get<Slot>('SELECT * FROM account_slots WHERE assigned_user_id=?', request.user.id);
      if (!slot || slot.status !== 'ASSIGNED') throw new HttpError(409, '专属账号不可用');
      if (!(JSON.parse(slot.cli_types) as string[]).includes(session.engine)) throw new HttpError(409, '该槽位未启用当前 CLI');
      if (project.sync_status !== 'WATCHING') throw new HttpError(409, '请先恢复项目同步');
      const model = input.model === undefined ? session.model : input.model;
      const reasoningEffort = input.reasoningEffort === undefined ? session.reasoning_effort : input.reasoningEffort;
      const runContext = {
        user: request.user, project, slot: { ...slot, cli_types: JSON.parse(slot.cli_types) as string[] },
        session: { ...session, model, reasoning_effort: reasoningEffort },
      };
      await validateAgentSelection(context.config, runContext, { model, reasoningEffort });
      store.run("UPDATE sessions SET status='running',updated_at=datetime('now') WHERE id=?", id);
      try {
        try { await workspaces.flush(project); }
        catch (error) {
          store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
          events.emit(request.user.id, { type: 'project', payload: { id: project.id, sync_status: 'ERROR' } });
          throw error;
        }
        const messageId = randomUUID();
        store.transaction(() => {
          store.run('UPDATE sessions SET model=?,reasoning_effort=? WHERE id=?', model, reasoningEffort, id);
          store.run("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'user',?)", messageId, id, content);
        });
        turns.start(id, messageId);
        events.emit(request.user.id, { type: 'message', sessionId: id, payload: store.get('SELECT * FROM messages WHERE id=?', messageId) });
        await agents.start({ ...runContext, session: { ...runContext.session, turn_id: messageId } }, content);
        return { sessionId: id, status: 'running' };
      } catch (error) {
        turns.finish(id, 'error');
        store.run("UPDATE sessions SET status='error',updated_at=datetime('now') WHERE id=?", id);
        const message = error instanceof Error ? error.message : String(error);
        events.emit(request.user.id, { type: 'error', sessionId: id, payload: { message } });
        throw new HttpError(502, message);
      }
    });
  });
  app.post('/api/sessions/:id/stop', async request => {
    const { id } = identifier.parse(request.params);
    const session = sessionFor(context, id, request.user.id);
    return withResourceLocks(context, [`project:${session.project_id}`], async () => {
      events.cancelSession(request.user.id, id);
      await agents.stop(id);
      if (!agents.isBusy(id)) turns.finish(id, 'interrupted');
      store.run("UPDATE sessions SET status='interrupted',updated_at=datetime('now') WHERE id=?", id);
      events.emit(request.user.id, { type: 'session', sessionId: id, payload: { id, status: 'interrupted' } });
      return { ok: true };
    });
  });
  app.get('/api/approvals', async request => store.all<Record<string, unknown> & { input: string }>(
    "SELECT * FROM approvals WHERE user_id=? AND status='pending' ORDER BY created_at", request.user.id,
  ).map(approval => ({ ...approval, input: JSON.parse(approval.input) })));
  app.post('/api/approvals/:id', async request => {
    const { id } = identifier.parse(request.params);
    const input = z.object({ decision: z.enum(['allow', 'deny']), reason: z.string().max(2000).optional() }).parse(request.body);
    events.resolveApproval(request.user.id, id, input);
    return { ok: true };
  });
}
