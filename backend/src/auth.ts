import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, type User } from './models.js';
import type { Store } from './database.js';
import type { Config } from './config.js';
import type { SshManager } from './runtime/ssh.js';
import type { ConnectionRegistry } from './connections.js';
import { createUser, credentials, verifyPassword } from './users.js';

const cookieName = 'cc_pool_session';
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

declare module 'fastify' {
  interface FastifyRequest { user: User; authSessionHash: string }
}

export function publicUser(user: User, sshPublicKey = '') {
  return { id: user.id, username: user.username, role: user.role, created_at: user.created_at, ssh_public_key: sshPublicKey };
}

export function registerAuth(app: FastifyInstance, store: Store, config: Config, ssh: SshManager, connections: ConnectionRegistry) {
  async function describe(user: User) {
    const key = await ssh.ensureUserKey(user.id);
    return publicUser(user, key.publicKey);
  }
  function createSession(user: User, reply: FastifyReply) {
    store.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now());
    const token = randomBytes(32).toString('base64url');
    const created = store.run(
      'INSERT INTO auth_sessions(token_hash,user_id,expires_at) SELECT ?,id,? FROM users WHERE id=? AND password_hash=?',
      tokenHash(token), Date.now() + sessionLifetime, user.id, user.password_hash,
    );
    if (created.changes !== 1) throw new HttpError(401, '密码已变更，请重新登录');
    reply.setCookie(cookieName, token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookie, maxAge: sessionLifetime / 1000,
    });
  }
  app.decorateRequest('user', null as unknown as User);
  app.decorateRequest('authSessionHash', '');
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (origin) {
      const expected = config.origin ?? `${request.protocol}://${request.host}`;
      if (origin !== expected) throw new HttpError(403, '请求来源不受信任');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '禁止跨站请求');
    const path = request.url.split('?')[0];
    if (['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/register'].includes(path)) return;
    const token = request.cookies[cookieName];
    const user = token && store.get<User>(
      'SELECT users.* FROM auth_sessions JOIN users ON users.id=auth_sessions.user_id WHERE token_hash=? AND expires_at>?',
      tokenHash(token), Date.now(),
    );
    if (!user) throw new HttpError(401, '请先登录');
    request.user = user;
    request.authSessionHash = tokenHash(token!);
  });
  app.get('/api/auth/status', async () => ({
    needsSetup: !store.get('SELECT id FROM users LIMIT 1'), registrationEnabled: config.registrationEnabled,
  }));
  const rateLimit = { max: 8, timeWindow: '1 minute' };
  for (const mode of ['setup', 'register'] as const) {
    app.post(`/api/auth/${mode}`, { config: { rateLimit } }, async (request, reply) => {
      const input = credentials.parse(request.body);
      if (mode === 'register' && !config.registrationEnabled) throw new HttpError(403, '当前未开放注册');
      if (mode === 'setup' && store.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, '平台已初始化');
      if (mode === 'register' && !store.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, '请先初始化管理员');
      const { user, publicKey } = await createUser(store, ssh, input, mode === 'setup' ? 'admin' : 'user', mode === 'setup');
      createSession(user, reply);
      return { user: publicUser(user, publicKey) };
    });
  }
  app.post('/api/auth/login', { config: { rateLimit } }, async (request, reply) => {
    const input = credentials.parse(request.body);
    const user = store.get<User>('SELECT * FROM users WHERE username=?', input.username);
    const validPassword = await verifyPassword(input.password, user?.password_hash);
    if (!user || !validPassword) throw new HttpError(401, '用户名或密码错误');
    store.assignSlot(user.id);
    createSession(user, reply);
    return { user: await describe(user) };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) {
      store.run('DELETE FROM auth_sessions WHERE token_hash=?', tokenHash(token));
      connections.revoke(tokenHash(token));
    }
    reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async request => ({
    user: await describe(request.user), slot: serializeSlot(store.assignSlot(request.user.id)),
  }));
  return { describe };
}

export function serializeSlot(slot: import('./models.js').Slot | null) {
  if (!slot) return null;
  const { home_dir: _home, ...publicSlot } = slot;
  return { ...publicSlot, cli_types: JSON.parse(slot.cli_types) as string[] };
}

export function requireAdmin(request: FastifyRequest) {
  if (request.user.role !== 'admin') throw new HttpError(403, '仅管理员可执行此操作');
}
