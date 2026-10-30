import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, publicUser } from '../auth.js';
import { HttpError, type Host, type Project, type Slot, type User } from '../models.js';
import { withResourceLocks, type Context } from '../context.js';
import { createUser, credentials } from '../users.js';
import { updateSlot } from '../accounts/assignments.js';
import { availableSlots, serializeAdminSlot, serializeUserSlot } from '../accounts/access.js';
import { initializeSlotLayout } from '../accounts/migration.js';
import { privateDirectory } from '../accounts/credential-files.js';

const slotId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export function adminRoutes(app: FastifyInstance, context: Context) {
  const { store, config, ssh, events } = context;
  app.get('/api/slots', async request => availableSlots(store, request.user.id).map(slot => serializeUserSlot(context, slot, request.user.id)));
  const usageSlots = (userId: string, admin: boolean) => admin
    ? store.all<Slot>('SELECT * FROM account_slots ORDER BY id') : availableSlots(store, userId);
  app.get('/api/slots/usage', async request => {
    const { refresh } = z.object({ refresh: z.enum(['0', '1']).default('0') }).parse(request.query);
    return config.usage!.views(usageSlots(request.user.id, request.user.role === 'admin'), refresh === '1');
  });
  app.post('/api/slots/:id/usage/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { id } = z.object({ id: slotId }).parse(request.params);
    const slot = usageSlots(request.user.id, request.user.role === 'admin').find(item => item.id === id);
    if (!slot) throw new HttpError(404, '槽位不存在或无权查看');
    try { return await config.usage!.refresh(slot); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
  });
  app.get('/api/admin/users', async request => {
    requireAdmin(request);
    return store.all<User>('SELECT * FROM users ORDER BY created_at').map(user => publicUser(user));
  });
  app.get('/api/admin/resources', async request => {
    requireAdmin(request);
    const { userId } = z.object({ userId: z.uuid() }).strict().parse(request.query);
    const user = store.get<User>('SELECT * FROM users WHERE id=?', userId);
    if (!user) throw new HttpError(404, '用户不存在');
    const hosts = store.all<Omit<Host, 'user_id'>>(`SELECT id,name,host,port,username,kind,status,created_at,
      jump_host,jump_port,jump_username FROM dev_hosts
      WHERE user_id=? AND (kind='ssh' OR ?='admin') ORDER BY kind,created_at`, user.id, user.role);
    const projects = store.all<Pick<Project, 'id' | 'dev_host_id' | 'name' | 'remote_path' | 'local_path'
      | 'sync_status' | 'created_at' | 'path_mode' | 'execution_mode'>>(`SELECT p.id,p.dev_host_id,p.name,
      p.remote_path,p.local_path,p.sync_status,p.created_at,p.path_mode,p.execution_mode
      FROM projects p JOIN dev_hosts h ON h.id=p.dev_host_id AND h.user_id=p.user_id
      WHERE p.user_id=? AND (h.kind='ssh' OR ?='admin') ORDER BY p.created_at`, user.id, user.role);
    const counts = store.all<{ project_id: string; count: number }>(`SELECT s.project_id,count(*) AS count
      FROM sessions s JOIN projects p ON p.id=s.project_id AND p.user_id=s.user_id
      JOIN dev_hosts h ON h.id=p.dev_host_id AND h.user_id=p.user_id
      WHERE s.user_id=? AND (h.kind='ssh' OR ?='admin') GROUP BY s.project_id`, user.id, user.role);
    return { user: publicUser(user), hosts, projects,
      sessionCounts: Object.fromEntries(counts.map(row => [row.project_id, row.count])) };
  });
  app.post('/api/admin/users', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    requireAdmin(request);
    const input = credentials.strict().parse(request.body);
    const { user, publicKey } = await createUser(store, ssh, input);
    return reply.code(201).send({ user: publicUser(user, publicKey), slots: [] });
  });
  app.get('/api/admin/slots', async request => {
    requireAdmin(request);
    return store.all<Slot>('SELECT * FROM account_slots ORDER BY id').map(slot => serializeAdminSlot(context, slot));
  });
  app.post('/api/admin/slots', async (request, reply) => {
    requireAdmin(request);
    const input = z.object({
      id: slotId, label: z.string().trim().min(1).max(100), engine: z.enum(['claude', 'codex']),
      allowedUserIds: z.array(z.uuid()).max(10000).default([]),
    }).strict().parse(request.body);
    return withResourceLocks(context, [`slot-config:${input.id}`], async () => {
      if (store.get('SELECT id FROM account_slots WHERE id=?', input.id)) throw new HttpError(409, '槽位编号已存在');
      const userIds = [...new Set(input.allowedUserIds)];
      for (const userId of userIds) {
        if (!store.get('SELECT id FROM users WHERE id=?', userId)) throw new HttpError(404, '授权用户不存在');
      }
      const homeDir = join(config.dataDir, 'slots', input.id);
      await privateDirectory(homeDir);
      await initializeSlotLayout(config.dataDir, { id: input.id, home_dir: homeDir });
      store.transaction(() => {
        store.run('INSERT INTO account_slots(id,label,home_dir,engine) VALUES(?,?,?,?)', input.id, input.label, homeDir, input.engine);
        for (const userId of userIds) store.run('INSERT INTO slot_user_access(slot_id,user_id) VALUES(?,?)', input.id, userId);
      });
      const created = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', input.id)!;
      const administrators = store.all<{ id: string }>("SELECT id FROM users WHERE role='admin'").map(user => user.id);
      for (const userId of new Set([...userIds, ...administrators])) {
        events.emit(userId, { type: 'slot', payload: { slots: availableSlots(store, userId).map(slot => serializeUserSlot(context, slot, userId)) } });
      }
      return reply.code(201).send(serializeAdminSlot(context, created));
    });
  });
  app.patch('/api/admin/slots/:id', async request => {
    requireAdmin(request);
    const { id } = z.object({ id: slotId }).parse(request.params);
    const input = z.object({
      status: z.enum(['IDLE', 'RATE_LIMITED', 'DISABLED']).optional(),
      label: z.string().trim().min(1).max(100).optional(), allowedUserIds: z.array(z.uuid()).max(10000).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
    }).strict().refine(value => value.label !== undefined || value.status !== undefined || value.allowedUserIds !== undefined,
      { message: '请提供槽位变更内容' }).parse(request.body);
    return serializeAdminSlot(context, await updateSlot(context, id, input));
  });
}
