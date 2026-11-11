import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicUser, requireAdmin } from '../auth.js';
import type { Context } from '../context.js';
import { HttpError, type User } from '../models.js';
import { deleteUser, restoreUser, signOut, suspendUser } from '../user-lifecycle.js';
import { credentials, hashPassword } from '../users.js';

const identifier = z.object({ id: z.uuid() });

export function adminUserRoutes(app: FastifyInstance, context: Context) {
  const { store } = context;
  const userFor = (id: string) => {
    const user = store.get<User>('SELECT * FROM users WHERE id=?', id);
    if (!user) throw new HttpError(404, '用户不存在');
    return user;
  };
  app.patch('/api/admin/users/:id', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    const { username } = z.object({ username: credentials.shape.username }).strict().parse(request.body);
    userFor(id);
    if (store.get('SELECT id FROM users WHERE username=? AND id<>?', username, id)) throw new HttpError(409, '用户名已存在');
    store.run('UPDATE users SET username=? WHERE id=?', username, id);
    return publicUser(userFor(id));
  });
  app.put('/api/admin/users/:id/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    const { password } = z.object({ password: credentials.shape.password }).strict().parse(request.body);
    userFor(id);
    store.run('UPDATE users SET password_hash=? WHERE id=?', await hashPassword(password), id);
    // Everyone signed in as the user must sign in again, except the administrator resetting their own password.
    signOut(context, id, id === request.user.id ? request.authSessionHash : undefined);
    return { ok: true };
  });
  app.post('/api/admin/users/:id/suspend', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    await suspendUser(context, id, request.user.id);
    return publicUser(userFor(id));
  });
  app.post('/api/admin/users/:id/restore', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    restoreUser(context, id);
    return publicUser(userFor(id));
  });
  app.delete('/api/admin/users/:id', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    // The username typed by the administrator guards against deleting the wrong account.
    const { confirm } = z.object({ confirm: z.string() }).strict().parse(request.body);
    if (confirm !== userFor(id).username) throw new HttpError(400, '确认内容与用户名不一致');
    await deleteUser(context, id, request.user.id);
    return { ok: true };
  });
}
