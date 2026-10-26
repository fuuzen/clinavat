import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type Project } from '../models.js';
import { type Context, assertProjectIdle, hostFor, projectFor, withResourceLocks } from '../context.js';
import { attachTerminal } from '../runtime/terminal.js';
import { hostRoutes } from './hosts.js';

const identifier = z.object({ id: z.uuid() });
const projectInput = z.object({
  name: z.string().trim().min(1).max(100), devHostId: z.uuid(),
  remotePath: z.string().min(2).max(4096).refine(value => value.startsWith('/') && !/[\0\n\r]/.test(value), '请输入远端绝对路径'),
});
export function resourceRoutes(app: FastifyInstance, context: Context) {
  hostRoutes(app, context);
  const { store, ssh, workspaces, config, events } = context;
  app.get('/api/projects', async request => store.all('SELECT * FROM projects WHERE user_id=? ORDER BY created_at', request.user.id));
  app.post('/api/projects', async (request, reply) => {
    const input = projectInput.parse(request.body);
    const id = randomUUID();
    return withResourceLocks(context, [`host:${input.devHostId}`, `project:${id}`], async () => {
      const host = hostFor(context, input.devHostId, request.user.id);
      if (store.get('SELECT id FROM projects WHERE dev_host_id=? AND remote_path=?', host.id, input.remotePath)) throw new HttpError(409, '该远端目录已创建项目');
      const project: Project = { id, user_id: request.user.id, dev_host_id: host.id, name: input.name, remote_path: input.remotePath, local_path: join(config.dataDir, 'workspaces', `proj_${id}`), sync_name: `proj-${id}`, sync_status: 'CREATING', created_at: new Date().toISOString() };
      store.run('INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name) VALUES(?,?,?,?,?,?,?)', id, project.user_id, host.id, project.name, project.remote_path, project.local_path, project.sync_name);
      try {
        await workspaces.create(request.user.id, host, project);
        store.run("UPDATE projects SET sync_status='WATCHING' WHERE id=?", id);
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(request.user.id, { type: 'project', payload: { id, sync_status: 'ERROR' } });
        throw new HttpError(502, `项目同步初始化失败，可重试同步：${error instanceof Error ? error.message : String(error)}`);
      }
      const ready = projectFor(context, id, request.user.id);
      events.emit(request.user.id, { type: 'project', payload: ready });
      return reply.code(201).send(ready);
    });
  });
  app.post('/api/projects/:id/sync', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, request.user.id);
      assertProjectIdle(context, id);
      try {
        await workspaces.create(request.user.id, hostFor(context, project.dev_host_id, request.user.id), project);
        await workspaces.flush(project);
        const health = await workspaces.status(project);
        store.run('UPDATE projects SET sync_status=? WHERE id=?', health.status, id);
        events.emit(request.user.id, { type: 'project', payload: { id, sync_status: health.status } });
        return { sync_status: health.status, health };
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        throw new HttpError(502, `同步失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
  app.delete('/api/projects/:id', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, request.user.id);
      assertProjectIdle(context, id);
      await workspaces.remove(project);
      store.run('DELETE FROM projects WHERE id=?', id);
      context.connections.revokeResource(`project:${id}`);
      return { ok: true };
    });
  });
  app.get('/api/projects/:id/files', async request => {
    const { id } = identifier.parse(request.params);
    const { path } = z.object({ path: z.string().max(4096).default('') }).parse(request.query);
    return workspaces.files(projectFor(context, id, request.user.id), path);
  });
  app.get('/api/projects/:id/file', async request => {
    const { id } = identifier.parse(request.params);
    const { path } = z.object({ path: z.string().min(1).max(4096) }).parse(request.query);
    return workspaces.file(projectFor(context, id, request.user.id), path);
  });
  app.get('/api/projects/:id/git', async request => {
    const { id } = identifier.parse(request.params);
    const project = projectFor(context, id, request.user.id);
    return withResourceLocks(context, [`host:${project.dev_host_id}`, `project:${id}`], () => {
      const current = projectFor(context, id, request.user.id);
      if (current.sync_status !== 'WATCHING') throw new HttpError(409, '请先恢复项目同步');
      return workspaces.git(request.user.id, hostFor(context, current.dev_host_id, request.user.id), current);
    });
  });
  app.get('/api/projects/:id/terminal', { websocket: true }, (socket, request) => {
    try {
      const unwatch = context.connections.watch(request.authSessionHash, () => socket.close(1008, '登录已失效'));
      socket.once('close', unwatch);
      const { id } = identifier.parse(request.params);
      const project = projectFor(context, id, request.user.id);
      void withResourceLocks(context, [`host:${project.dev_host_id}`, `project:${id}`], async () => {
        const current = projectFor(context, id, request.user.id);
        if (current.sync_status !== 'WATCHING') throw new HttpError(409, '请先恢复项目同步');
        const unwatchProject = context.connections.watchResource(`project:${id}`, () => socket.close(1008, '项目或连接配置已变更'));
        socket.once('close', unwatchProject);
        await attachTerminal(socket, request.user.id, hostFor(context, current.dev_host_id, request.user.id), current, ssh, workspaces);
      }).catch(error => {
        socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })); socket.close();
      });
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })); socket.close();
    }
  });
}
