import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Context, assertProjectIdle, hostFor, withResourceLocks } from '../context.js';
import { HttpError, type Host, type Project } from '../models.js';
import { isValidSshHost } from '../runtime/types.js';

const identifier = z.object({ id: z.uuid() });
const portInput = z.coerce.number().int().min(1).max(65535);
const endpointFields = {
  host: z.string().trim().min(1).max(253).refine(isValidSshHost, '请输入有效的域名或 IP 地址，用户名和端口请分别填写'),
  port: portInput.default(22),
  username: z.string().trim().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/).max(64),
  privateKey: z.string().trim().min(1).max(65536).optional(),
};
const hostInput = z.object({
  name: z.string().trim().min(1).max(100),
  ...endpointFields,
  jumpHost: z.object(endpointFields).nullable().optional(),
});
const hostPatch = hostInput.partial().extend({ port: portInput.optional() });

function jumpFields(jump: z.infer<typeof hostInput>['jumpHost']): Pick<Host, 'jump_host' | 'jump_port' | 'jump_username'> {
  return {
    jump_host: jump?.host ?? null,
    jump_port: jump?.port ?? null,
    jump_username: jump?.username ?? null,
  };
}

async function validateKeys(context: Context, userId: string, keys: (string | undefined)[]) {
  try {
    await Promise.all(keys.filter((key): key is string => !!key)
      .map(key => context.ssh.keys.validatePrivateKey(userId, key)));
  } catch (error) {
    throw new HttpError(400, `SSH 私钥无效，请使用无需口令的私钥：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function hostRoutes(app: FastifyInstance, context: Context) {
  const { store, ssh, events } = context;
  app.get('/api/hosts', async request => store.all('SELECT * FROM dev_hosts WHERE user_id=? ORDER BY created_at', request.user.id));
  app.post('/api/hosts', async (request, reply) => {
    const input = hostInput.parse(request.body);
    return withResourceLocks(context, [`user-hosts:${request.user.id}`], async () => {
      const host: Host = {
        id: randomUUID(), user_id: request.user.id, name: input.name, host: input.host,
        port: input.port, username: input.username, status: 'DISCONNECTED',
        created_at: new Date().toISOString(), ...jumpFields(input.jumpHost),
      };
      await validateKeys(context, request.user.id, [input.privateKey, input.jumpHost?.privateKey]);
      try {
        await ssh.addHost(request.user.id, host, input.privateKey, input.jumpHost?.privateKey);
        store.run('INSERT INTO dev_hosts(id,user_id,name,host,port,username,jump_host,jump_port,jump_username) VALUES(?,?,?,?,?,?,?,?,?)',
          host.id, host.user_id, host.name, host.host, host.port, host.username,
          host.jump_host ?? null, host.jump_port ?? null, host.jump_username ?? null);
      } catch (error) {
        await ssh.deleteHost(request.user.id, host).catch(() => undefined);
        throw new HttpError(400, `无法保存 SSH 配置：${error instanceof Error ? error.message : String(error)}`);
      }
      return reply.code(201).send(host);
    });
  });
  app.patch('/api/hosts/:id', async request => {
    const { id } = identifier.parse(request.params);
    const input = hostPatch.parse(request.body);
    hostFor(context, id, request.user.id);
    const projects = store.all<Project>('SELECT * FROM projects WHERE dev_host_id=? AND user_id=?', id, request.user.id);
    return withResourceLocks(context, [`host:${id}`, `user-hosts:${request.user.id}`, ...projects.map(project => `project:${project.id}`)], async () => {
      const previous = hostFor(context, id, request.user.id);
      const host: Host = {
        ...previous,
        name: input.name ?? previous.name,
        host: input.host ?? previous.host,
        port: input.port ?? previous.port,
        username: input.username ?? previous.username,
        ...(input.jumpHost === undefined ? {} : jumpFields(input.jumpHost)),
      };
      const changed = !!input.privateKey || !!input.jumpHost?.privateKey ||
        (['host', 'port', 'username', 'jump_host', 'jump_port', 'jump_username'] as const)
          .some(field => (host[field] ?? null) !== (previous[field] ?? null));
      if (!changed) {
        store.run('UPDATE dev_hosts SET name=? WHERE id=?', host.name, id);
        return hostFor(context, id, request.user.id);
      }
      for (const project of projects) assertProjectIdle(context, project.id);
      await validateKeys(context, request.user.id, [input.privateKey, input.jumpHost?.privateKey]);
      try {
        for (const project of projects) {
          await context.workspaces.pause(project);
          store.run("UPDATE projects SET sync_status='PAUSED' WHERE id=?", project.id);
          events.emit(request.user.id, { type: 'project', payload: { id: project.id, sync_status: 'PAUSED' } });
          context.connections.revokeResource(`project:${project.id}`);
        }
        await ssh.disconnectHost(request.user.id, previous);
        await ssh.addHost(request.user.id, host, input.privateKey, input.jumpHost?.privateKey);
        store.run("UPDATE dev_hosts SET name=?,host=?,port=?,username=?,jump_host=?,jump_port=?,jump_username=?,status='DISCONNECTED' WHERE id=?",
          host.name, host.host, host.port, host.username, host.jump_host ?? null,
          host.jump_port ?? null, host.jump_username ?? null, id);
      } catch (error) {
        await ssh.addHost(request.user.id, previous).catch(() => undefined);
        throw new HttpError(502, `SSH 配置更新失败，项目同步已暂停，可检查后重试：${error instanceof Error ? error.message : String(error)}`);
      }
      return hostFor(context, id, request.user.id);
    });
  });
  app.post('/api/hosts/:id/connect', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`host:${id}`], async () => {
      const host = hostFor(context, id, request.user.id);
      try {
        const result = await ssh.connect(request.user.id, host);
        store.run("UPDATE dev_hosts SET status='CONNECTED' WHERE id=?", id);
        return result;
      } catch (error) {
        store.run("UPDATE dev_hosts SET status='ERROR' WHERE id=?", id);
        throw new HttpError(502, `SSH 连接失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
  app.get('/api/hosts/:id/directories', async request => {
    const { id } = identifier.parse(request.params);
    const { path } = z.object({ path: z.string().max(4096).default('/') }).parse(request.query);
    return withResourceLocks(context, [`host:${id}`], () => ssh.listDirectories(request.user.id, hostFor(context, id, request.user.id), path));
  });
  app.delete('/api/hosts/:id', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`host:${id}`, `user-hosts:${request.user.id}`], async () => {
      const host = hostFor(context, id, request.user.id);
      if (store.get('SELECT id FROM projects WHERE dev_host_id=?', id)) throw new HttpError(409, '请先删除开发机下的项目');
      await ssh.deleteHost(request.user.id, host);
      store.run('DELETE FROM dev_hosts WHERE id=?', id);
      return { ok: true };
    });
  });
}
