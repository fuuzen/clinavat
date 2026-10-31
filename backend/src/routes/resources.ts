import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type Project } from '../models.js';
import { type Context, assertProjectIdle, hostFor, projectFor, withResourceLocks } from '../context.js';
import { attachTerminal } from '../runtime/terminal.js';
import { appendIgnoreRules, assertIgnorePath } from '../runtime/sync-scan.js';
import { shellQuote } from '../runtime/types.js';
import { hostRoutes } from './hosts.js';
import { localProjectPath } from './local-projects.js';
import { workspaceFileRoutes } from './workspace-files.js';

const identifier = z.object({ id: z.uuid() });
const projectInput = z.object({
  name: z.string().trim().min(1).max(100), devHostId: z.uuid(),
  source: z.enum(['existing', 'new']).default('existing'),
  pathMode: z.enum(['auto', 'bwrap', 'symlink']).default('auto'),
  remotePath: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\0\n\r]/.test(value), '请输入绝对路径').optional(),
  // Paths chosen from the pre-sync scan, appended to the remote ignore file before the first sync.
  ignorePaths: z.array(z.string().refine(path => { try { assertIgnorePath(path); return true; } catch { return false; } }, '排除路径无效')).max(50).default([]),
}).refine(input => input.source === 'new' || !!input.remotePath, { message: '请选择已有目录', path: ['remotePath'] });
export function resourceRoutes(app: FastifyInstance, context: Context) {
  hostRoutes(app, context);
  workspaceFileRoutes(app, context);
  const { store, ssh, workspaces, config, events } = context;
  app.get('/api/projects', async request => store.all(`SELECT projects.* FROM projects
    JOIN dev_hosts ON dev_hosts.id=projects.dev_host_id
    WHERE projects.user_id=? AND (dev_hosts.kind='ssh' OR ?='admin') ORDER BY projects.created_at`, request.user.id, request.user.role));
  app.post('/api/projects', async (request, reply) => {
    const input = projectInput.parse(request.body);
    const id = randomUUID();
    return withResourceLocks(context, [`host:${input.devHostId}`, `project:${id}`], async () => {
      const host = hostFor(context, input.devHostId, request.user.id);
      const local = host.kind === 'local';
      const localPath = local ? await localProjectPath(input.remotePath, input.source) : join(config.workspaceDir, `proj_${id}`);
      const remotePath = local ? localPath : input.source === 'new' ? localPath : input.remotePath!;
      if (store.get('SELECT id FROM projects WHERE dev_host_id=? AND remote_path=?', host.id, remotePath)) throw new HttpError(409, '该远端目录已创建项目');
      if (input.ignorePaths.length) {
        if (local || input.source === 'new') throw new HttpError(400, '仅连接已有远端目录时可以添加同步排除规则');
        try { await appendIgnoreRules(ssh, request.user.id, host, remotePath, input.ignorePaths); }
        catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      }
      if (!local && input.source === 'new') {
        const created = await ssh.exec(request.user.id, host, `set -e; umask 077; if [ -L ${shellQuote(config.workspaceDir)} ]; then printf '%s\\n' '远端工作区根目录不能是软链接' >&2; exit 73; fi; if [ ! -d ${shellQuote(config.workspaceDir)} ]; then mkdir -m 1777 -- ${shellQuote(config.workspaceDir)}; fi; mkdir -m 700 -- ${shellQuote(remotePath)}`);
        if (created.code !== 0) throw new HttpError(502, `无法新建远端项目目录：${created.stderr.trim()}`);
      }
      const project: Project = { id, user_id: request.user.id, dev_host_id: host.id, name: input.name, remote_path: remotePath, local_path: localPath, sync_name: `proj-${id}`, sync_status: 'CREATING', created_at: new Date().toISOString(), path_mode: local || input.source === 'new' ? 'direct' : input.pathMode, execution_mode: local ? 'local' : null };
      store.run('INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name,path_mode,execution_mode) VALUES(?,?,?,?,?,?,?,?,?)', id, project.user_id, host.id, project.name, project.remote_path, project.local_path, project.sync_name, project.path_mode, project.execution_mode);
      try {
        await workspaces.create(request.user.id, host, project);
        store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?', local ? 'LOCAL' : 'WATCHING', project.execution_mode, id);
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(request.user.id, { type: 'project', payload: { id, sync_status: 'ERROR' } });
        throw new HttpError(502, `${local ? '本机项目初始化失败，可检查目录后重试' : '项目同步初始化失败，可重试同步'}：${error instanceof Error ? error.message : String(error)}`);
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
        store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?', health.status, project.execution_mode, id);
        events.emit(request.user.id, { type: 'project', payload: { id, sync_status: health.status, execution_mode: project.execution_mode } });
        return { sync_status: health.status, health };
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        throw new HttpError(502, `同步失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
  app.patch('/api/projects/:id', async request => {
    const { id } = identifier.parse(request.params);
    const { pathMode } = z.object({ pathMode: z.enum(['auto', 'bwrap', 'symlink']) }).parse(request.body);
    return withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, request.user.id);
      if (project.execution_mode === 'local') throw new HttpError(400, '本机项目直接使用实际目录，无需配置路径映射');
      assertProjectIdle(context, id);
      await workspaces.pause(project);
      context.connections.revokeResource(`project:${id}`);
      project.path_mode = pathMode;
      store.run("UPDATE projects SET path_mode=?,sync_status='PAUSED' WHERE id=?", pathMode, id);
      try {
        await workspaces.create(request.user.id, hostFor(context, project.dev_host_id, request.user.id), project);
        const health = await workspaces.status(project);
        store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?', health.status, project.execution_mode, id);
        const updated = projectFor(context, id, request.user.id);
        events.emit(request.user.id, { type: 'project', payload: updated });
        return updated;
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(request.user.id, { type: 'project', payload: { id, path_mode: pathMode, sync_status: 'ERROR' } });
        throw new HttpError(502, `路径模式更新失败，可调整后重试：${error instanceof Error ? error.message : String(error)}`);
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
  app.get('/api/projects/:id/usage', async request => {
    const { id } = identifier.parse(request.params);
    return workspaces.usage(projectFor(context, id, request.user.id));
  });
  app.get('/api/projects/:id/git', async request => {
    const { id } = identifier.parse(request.params);
    const project = projectFor(context, id, request.user.id);
    return withResourceLocks(context, [`host:${project.dev_host_id}`, `project:${id}`], () => {
      const current = projectFor(context, id, request.user.id);
      if (!['WATCHING', 'LOCAL'].includes(current.sync_status)) throw new HttpError(409, '请先恢复项目同步');
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
        if (!['WATCHING', 'LOCAL'].includes(current.sync_status)) throw new HttpError(409, '请先恢复项目同步');
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
