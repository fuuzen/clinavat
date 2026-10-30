import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Context, projectFor, sessionFor, withResourceLocks } from '../context.js';
import { HttpError } from '../models.js';
import { publicUser } from '../auth.js';
import { validateAgentSelection } from '../agent/model-catalog.js';
import { permissionModes, validatePermissionMode } from '../agent/permissions.js';
import { ensureLocalHost } from '../local-host.js';
import { availableSlots, serializeUserSlot, slotForUser } from '../accounts/access.js';
import { sessionMessageRoutes, selectedSlotId, selectionFields } from './session-messages.js';
import { sessionGoalRoutes } from './session-goals.js';
import { agentModes, rolePresets, validateSessionSettings } from '../agent/session-settings.js';

const identifier = z.object({ id: z.uuid() });
export function sessionRoutes(app: FastifyInstance, context: Context) {
  const { store, events, agents, ssh, turns } = context;
  app.get('/api/overview', async request => {
    const key = await ssh.ensureUserKey(request.user.id);
    if (request.user.role === 'admin') ensureLocalHost(store, request.user.id);
    return {
      user: publicUser(request.user, key.publicKey),
      slots: availableSlots(store, request.user.id).map(slot => serializeUserSlot(context, slot, request.user.id)),
      hosts: store.all("SELECT * FROM dev_hosts WHERE user_id=? AND (kind='ssh' OR ?='admin') ORDER BY kind,created_at", request.user.id, request.user.role),
      projects: store.all(`SELECT projects.* FROM projects JOIN dev_hosts ON dev_hosts.id=projects.dev_host_id
        WHERE projects.user_id=? AND (dev_hosts.kind='ssh' OR ?='admin') ORDER BY projects.created_at`, request.user.id, request.user.role),
      sessions: store.all(`SELECT sessions.* FROM sessions JOIN projects ON projects.id=sessions.project_id
        JOIN dev_hosts ON dev_hosts.id=projects.dev_host_id WHERE sessions.user_id=?
        AND (dev_hosts.kind='ssh' OR ?='admin') ORDER BY sessions.updated_at DESC`, request.user.id, request.user.role),
    };
  });
  app.post('/api/sessions', async (request, reply) => {
    const input = z.object({ projectId: z.uuid(), engine: z.enum(['claude', 'codex']), slotId: selectedSlotId,
      title: z.string().trim().min(1).max(200).default('新对话'), ...selectionFields }).parse(request.body);
    return withResourceLocks(context, [], async () => {
      const project = projectFor(context, input.projectId, request.user.id);
      const slot = slotForUser(store, input.slotId, request.user.id, input.engine);
      const permissionMode = validatePermissionMode(input.engine, input.permissionMode ?? 'manual');
      const { agentMode, rolePreset } = validateSessionSettings(input.engine, input.agentMode ?? 'normal', input.rolePreset ?? 'default');
      const id = randomUUID();
      await validateAgentSelection(context.config, {
        runtime_home: slot.home_dir, runtime_kind: 'probe',
        user: request.user, project, slot,
        session: { id: '', engine: input.engine, model: input.model ?? null, reasoning_effort: input.reasoningEffort ?? null, permission_mode: permissionMode },
      }, input);
      slotForUser(store, slot.id, request.user.id, input.engine);
      store.run('INSERT INTO sessions(id,project_id,user_id,engine,slot_id,title,model,reasoning_effort,permission_mode,agent_mode,role_preset) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id, input.projectId, request.user.id, input.engine, slot.id, input.title, input.model ?? null, input.reasoningEffort ?? null, permissionMode, agentMode, rolePreset);
      return reply.code(201).send(sessionFor(context, id, request.user.id));
    }, [`project:${input.projectId}`]);
  });
  app.patch('/api/sessions/:id', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    const input = z.object({
      title: z.string().trim().min(1).max(200).optional(),
      permissionMode: z.enum(permissionModes).optional(),
      agentMode: z.enum(agentModes).optional(),
      rolePreset: z.enum(rolePresets).optional(),
      slotId: selectedSlotId.nullable().optional(),
    }).strict().refine(value => Object.values(value).some(item => item !== undefined), {
      message: '请提供要修改的对话设置',
    }).parse(request.body);
    return withResourceLocks(context, [`session:${id}`], () => {
      const current = sessionFor(context, id, request.user.id);
      const permissionMode = validatePermissionMode(current.engine, input.permissionMode ?? current.permission_mode);
      const { agentMode, rolePreset } = validateSessionSettings(current.engine,
        input.agentMode ?? current.agent_mode, input.rolePreset ?? current.role_preset);
      const changedSlot = input.slotId !== undefined && input.slotId !== current.slot_id;
      if (changedSlot || permissionMode !== current.permission_mode || agentMode !== current.agent_mode || rolePreset !== current.role_preset) {
        if (agents.isBusy(id) || ['running', 'waiting', 'pausing', 'paused'].includes(current.status)
          || context.config.credentials.isSessionBusy(id)) {
          throw new HttpError(409, '对话仍在运行或回收状态，请等待结束或先停止后修改');
        }
      }
      if (changedSlot && input.slotId) slotForUser(store, input.slotId, request.user.id, current.engine);
      store.run(`UPDATE sessions SET title=?,permission_mode=?,slot_id=?,model=?,reasoning_effort=?,agent_mode=?,role_preset=?,updated_at=datetime('now') WHERE id=?`,
        input.title ?? current.title, permissionMode, input.slotId === undefined ? current.slot_id : input.slotId,
        changedSlot ? null : current.model, changedSlot ? null : current.reasoning_effort, agentMode, rolePreset, id);
      const updated = sessionFor(context, id, request.user.id);
      events.emit(request.user.id, { type: 'session', sessionId: id, payload: updated });
      return updated;
    });
  });
  app.delete('/api/sessions/:id', async request => {
    const { id } = identifier.parse(request.params);
    const session = sessionFor(context, id, request.user.id);
    return withResourceLocks(context, [`project:${session.project_id}`, `session:${id}`], async () => {
      const current = sessionFor(context, id, request.user.id);
      if (agents.isBusy(id) || ['running', 'waiting', 'pausing', 'paused'].includes(current.status)) {
        throw new HttpError(409, '请等待会话结束并完成状态回收，或先停止会话');
      }
      await context.config.credentials.retrySessionRelease(id);
      if (context.config.credentials.isSessionBusy(id)) throw new HttpError(409, '会话状态尚未回收，请先停止会话后重试');
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
  sessionMessageRoutes(app, context);
  sessionGoalRoutes(app, context);
  app.get('/api/sessions/:id/questions', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    return agents.questions.list(id);
  });
  app.post('/api/sessions/:id/questions/:requestId', async request => {
    const { id, requestId } = z.object({ id: z.uuid(), requestId: z.uuid() }).parse(request.params);
    sessionFor(context, id, request.user.id);
    const input = z.object({
      answers: z.record(z.string().max(200), z.array(z.string().max(10000)).max(20)).default({}),
      skip: z.boolean().default(false),
    }).parse(request.body);
    agents.questions.answer(id, requestId, input.answers, input.skip);
    return { ok: true };
  });
  app.post('/api/sessions/:id/stop', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    return withResourceLocks(context, [`session:${id}`], async () => {
      events.cancelSession(request.user.id, id);
      try { await agents.stop(id); }
      catch (error) {
        if (agents.isBusy(id)) throw error;
        await context.config.credentials.retrySessionRelease(id);
        if (context.config.credentials.isSessionBusy(id)) throw error;
      }
      if (agents.isBusy(id)) throw new HttpError(409, '会话尚未停止，请稍后重试');
      await context.config.credentials.retrySessionRelease(id);
      if (context.config.credentials.isSessionBusy(id)) throw new HttpError(409, '会话状态尚未回收，请稍后重试');
      if (!agents.isBusy(id)) turns.finish(id, 'interrupted');
      const current = sessionFor(context, id, request.user.id);
      const status = current.status === 'error' ? 'error' : 'interrupted';
      store.run("UPDATE sessions SET status=?,updated_at=datetime('now') WHERE id=?", status, id);
      events.emit(request.user.id, { type: 'session', sessionId: id, payload: { id, status } });
      return { ok: true };
    });
  });
  for (const action of ['pause', 'resume'] as const) {
    app.post(`/api/sessions/:id/${action}`, async request => {
      const { id } = identifier.parse(request.params);
      sessionFor(context, id, request.user.id);
      z.object({}).strict().parse(request.body ?? {});
      const { operation } = await withResourceLocks(context, [`session:${id}`], () => ({ operation: agents[action](id) }));
      return { status: await operation };
    });
  }
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
