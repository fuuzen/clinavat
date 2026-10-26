import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, publicUser, serializeSlot } from '../auth.js';
import { HttpError, type Slot, type User } from '../models.js';
import type { Context } from '../context.js';
import { createUser, credentials } from '../users.js';

const slotId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
const serialize = (slot: Slot) => ({ ...slot, cli_types: JSON.parse(slot.cli_types) as string[] });
export function adminRoutes(app: FastifyInstance, { store, config, ssh }: Context) {
  app.get('/api/admin/users', async request => {
    requireAdmin(request);
    return store.all<User>('SELECT * FROM users ORDER BY created_at').map(user => publicUser(user));
  });
  app.post('/api/admin/users', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    requireAdmin(request);
    const input = credentials.strict().parse(request.body);
    const { user, slot, publicKey } = await createUser(store, ssh, input);
    return reply.code(201).send({ user: publicUser(user, publicKey), slot: serializeSlot(slot) });
  });
  app.get('/api/admin/slots', async request => {
    requireAdmin(request);
    return store.all<Slot>('SELECT * FROM account_slots ORDER BY id').map(serialize);
  });
  app.post('/api/admin/slots', async (request, reply) => {
    requireAdmin(request);
    const input = z.object({ id: slotId, label: z.string().trim().min(1).max(100), cliTypes: z.array(z.enum(['claude', 'codex'])).min(1).max(2) }).parse(request.body);
    if (store.get('SELECT id FROM account_slots WHERE id=?', input.id)) throw new HttpError(409, '槽位编号已存在');
    const homeDir = join(config.dataDir, 'slots', input.id);
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    await chmod(homeDir, 0o700);
    store.run('INSERT INTO account_slots(id,label,home_dir,cli_types) VALUES(?,?,?,?)', input.id, input.label, homeDir, JSON.stringify([...new Set(input.cliTypes)]));
    return reply.code(201).send(serialize(store.get<Slot>('SELECT * FROM account_slots WHERE id=?', input.id)!));
  });
  app.patch('/api/admin/slots/:id', async request => {
    requireAdmin(request);
    const { id } = z.object({ id: slotId }).parse(request.params);
    const input = z.object({ status: z.enum(['IDLE', 'ASSIGNED', 'RATE_LIMITED', 'DISABLED']).optional(), label: z.string().trim().min(1).max(100).optional(), assignedUserId: z.uuid().optional() }).parse(request.body);
    const updated = store.transaction(() => {
      const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', id);
      if (!slot) throw new HttpError(404, '槽位不存在');
      if (input.assignedUserId && input.assignedUserId !== slot.assigned_user_id) {
        if (slot.assigned_user_id) throw new HttpError(409, '槽位已永久绑定，不能转给其他用户');
        if (!store.get('SELECT id FROM users WHERE id=?', input.assignedUserId)) throw new HttpError(404, '用户不存在');
        if (store.get('SELECT id FROM account_slots WHERE assigned_user_id=?', input.assignedUserId)) throw new HttpError(409, '该用户已有专属账号');
      }
      const assigned = input.assignedUserId ?? slot.assigned_user_id;
      const status = input.status ?? (input.assignedUserId ? 'ASSIGNED' : slot.status);
      if ((status === 'IDLE' && assigned) || (status === 'ASSIGNED' && !assigned)) throw new HttpError(400, '槽位状态与绑定关系不一致');
      if (assigned && store.get("SELECT id FROM sessions WHERE user_id=? AND status IN ('running','waiting')", assigned)) throw new HttpError(409, '用户会话正在运行，请先停止再调整槽位');
      store.run("UPDATE account_slots SET label=?,status=?,assigned_user_id=?,updated_at=datetime('now') WHERE id=?", input.label ?? slot.label, status, assigned, id);
      return store.get<Slot>('SELECT * FROM account_slots WHERE id=?', id)!;
    });
    return serialize(updated);
  });
}
