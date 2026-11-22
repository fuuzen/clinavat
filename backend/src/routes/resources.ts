import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type Host, type Project } from '../models.js';
import { type Context, assertProjectIdle, hostFor, projectFor, withResourceLocks } from '../context.js';
import { attachTerminal } from '../runtime/terminal.js';
import { DEFAULT_IGNORES, literalIgnore } from '../runtime/sync-policy.js';
import { SYNC_RULES_LIMIT, assertSyncRules, readLegacyRules, removeLegacyRules } from '../runtime/sync-rules.js';
import { assertIgnorePath } from '../runtime/sync-scan.js';
import { shellQuote } from '../runtime/types.js';
import { hostRoutes } from './hosts.js';
import { localProjectPath } from './local-projects.js';
import { workspaceFileRoutes } from './workspace-files.js';

const identifier = z.object({ id: z.uuid() });
const firstSyncTimeout = 30 * 60_000;
const projectInput = z.object({
  name: z.string().trim().min(1).max(100), devHostId: z.uuid(),
  source: z.enum(['existing', 'new']).default('existing'),
  pathMode: z.enum(['auto', 'bwrap', 'symlink']).default('auto'),
  remotePath: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\0\n\r]/.test(value), '请输入绝对路径').optional(),
  // Paths chosen from the pre-sync scan, added to the project's ignore rules before the first sync.
  ignorePaths: z.array(z.string().refine(path => { try { assertIgnorePath(path); return true; } catch { return false; } }, '排除路径无效')).max(50).default([]),
}).refine(input => input.source === 'new' || !!input.remotePath, { message: '请选择已有目录', path: ['remotePath'] });
export function resourceRoutes(app: FastifyInstance, context: Context) {
  hostRoutes(app, context);
  workspaceFileRoutes(app, context);
  const { store, ssh, workspaces, config, events } = context;
  // A project from before Clinavat kept the rules imports its remote .clinavatignore once; the file then goes away.
  async function migrateSyncRules(userId: string, host: Host, project: Project, replacement?: string) {
    if (project.sync_rules !== null) return;
    const legacy = await readLegacyRules(ssh, userId, host, project.remote_path);
    project.sync_rules = replacement ?? legacy ?? '';
    store.run('UPDATE projects SET sync_rules=? WHERE id=?', project.sync_rules, project.id);
    if (legacy !== null) await removeLegacyRules(ssh, userId, host, project.remote_path);
  }
  function assertNotRebuilding(project: Project) {
    if (project.sync_status === 'CREATING') throw new HttpError(409, '项目正在建立同步，请等待完成');
  }
  app.get('/api/projects', async request => store.all(`SELECT projects.* FROM projects
    JOIN dev_hosts ON dev_hosts.id=projects.dev_host_id
    WHERE projects.user_id=? AND (dev_hosts.kind='ssh' OR ?='admin') ORDER BY projects.created_at`, request.user.id, request.user.role));
  app.post('/api/projects', async (request, reply) => {
    const input = projectInput.parse(request.body);
    const id = randomUUID();
    const userId = request.user.id;
    const created = await withResourceLocks(context, [`host:${input.devHostId}`, `project:${id}`], async () => {
      const host = hostFor(context, input.devHostId, userId);
      const local = host.kind === 'local';
      const localPath = local ? await localProjectPath(input.remotePath, input.source) : join(config.workspaceDir, `proj_${id}`);
      const remotePath = local ? localPath : input.source === 'new' ? localPath : input.remotePath!;
      if (store.get('SELECT id FROM projects WHERE dev_host_id=? AND remote_path=?', host.id, remotePath)) throw new HttpError(409, '该远端目录已创建项目');
      if (input.ignorePaths.length && (local || input.source === 'new')) throw new HttpError(400, '仅连接已有远端目录时可以添加同步排除规则');
      let rules = '';
      if (!local && input.source === 'existing') {
        try {
          // The directory may still hold the rule file of an earlier project; its rules carry over into this one.
          const legacy = await readLegacyRules(ssh, userId, host, remotePath);
          rules = [legacy?.trimEnd(), ...input.ignorePaths.map(literalIgnore)].filter(Boolean).join('\n');
          if (legacy !== null) await removeLegacyRules(ssh, userId, host, remotePath);
        } catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      }
      if (!local && input.source === 'new') {
        const created = await ssh.exec(userId, host, `set -e; umask 077; if [ -L ${shellQuote(config.workspaceDir)} ]; then printf '%s\\n' '远端工作区根目录不能是软链接' >&2; exit 73; fi; if [ ! -d ${shellQuote(config.workspaceDir)} ]; then mkdir -m 1777 -- ${shellQuote(config.workspaceDir)}; fi; mkdir -m 700 -- ${shellQuote(remotePath)}`);
        if (created.code !== 0) throw new HttpError(502, `无法新建远端项目目录：${created.stderr.trim()}`);
      }
      const project: Project = { id, user_id: userId, dev_host_id: host.id, name: input.name, remote_path: remotePath, local_path: localPath, sync_name: `proj-${id}`, sync_status: 'CREATING', created_at: new Date().toISOString(), path_mode: local || input.source === 'new' ? 'direct' : input.pathMode, execution_mode: local ? 'local' : null, sync_rules: rules };
      store.run('INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name,path_mode,execution_mode,sync_rules) VALUES(?,?,?,?,?,?,?,?,?,?)', id, project.user_id, host.id, project.name, project.remote_path, project.local_path, project.sync_name, project.path_mode, project.execution_mode, project.sync_rules);
      if (!local) return { host, project };
      try {
        await workspaces.create(userId, host, project);
        store.run("UPDATE projects SET sync_status='LOCAL' WHERE id=?", id);
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(userId, { type: 'project', payload: { id, sync_status: 'ERROR' } });
        throw new HttpError(502, `本机项目初始化失败，可检查目录后重试：${error instanceof Error ? error.message : String(error)}`);
      }
      return { host, project };
    });
    const { host, project } = created;
    if (project.execution_mode === 'local') {
      const ready = projectFor(context, id, userId);
      events.emit(userId, { type: 'project', payload: ready });
      return reply.code(201).send(ready);
    }
    // The first sync of a large directory can take minutes, so it continues after the response under the project lock.
    // The id is new and not yet known to any client, so no other request can take that lock in between.
    void withResourceLocks(context, [`project:${id}`], async () => {
      try {
        await workspaces.create(userId, host, project, firstSyncTimeout);
        store.run("UPDATE projects SET sync_status='WATCHING',execution_mode=? WHERE id=?", project.execution_mode, id);
        events.emit(userId, { type: 'project', payload: projectFor(context, id, userId) });
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(userId, { type: 'project', payload: { id, sync_status: 'ERROR' } });
        events.emit(userId, { type: 'error', payload: { message: `项目「${project.name}」首次同步失败，可在工作区重试同步：${error instanceof Error ? error.message : String(error)}` } });
      }
    }).catch(error => request.log.error({ err: error, projectId: id }, '无法开始项目首次同步'));
    events.emit(userId, { type: 'project', payload: project });
    return reply.code(202).send(project);
  });
  app.get('/api/projects/:id/sync-progress', async request => {
    const { id } = identifier.parse(request.params);
    const project = projectFor(context, id, request.user.id);
    if (project.sync_status !== 'CREATING' || project.execution_mode === 'local') return null;
    try { return await workspaces.progress(project); }
    catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
  });
  app.post('/api/projects/:id/sync', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, request.user.id);
      assertNotRebuilding(project);
      await assertProjectIdle(context, id);
      try {
        const host = hostFor(context, project.dev_host_id, request.user.id);
        await migrateSyncRules(request.user.id, host, project);
        await workspaces.create(request.user.id, host, project);
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
      assertNotRebuilding(project);
      await assertProjectIdle(context, id);
      const host = hostFor(context, project.dev_host_id, request.user.id);
      try { await migrateSyncRules(request.user.id, host, project); }
      catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      await workspaces.pause(project);
      context.connections.revokeResource(`project:${id}`);
      project.path_mode = pathMode;
      store.run("UPDATE projects SET path_mode=?,sync_status='PAUSED' WHERE id=?", pathMode, id);
      try {
        await workspaces.create(request.user.id, host, project);
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
  // Run by the Hub in each new worktree of a child agent, without approval: only the project's owner sets it.
  app.put('/api/projects/:id/worktree-setup', async request => {
    const { id } = identifier.parse(request.params);
    const { command } = z.object({ command: z.string().max(4000).nullable() }).strict().parse(request.body);
    const project = projectFor(context, id, request.user.id);
    if (project.parent_project_id) throw new HttpError(400, '子智能体的 worktree 使用主项目的初始化命令');
    store.run('UPDATE projects SET worktree_setup=? WHERE id=?', command?.trim() || null, id);
    const updated = projectFor(context, id, request.user.id);
    events.emit(request.user.id, { type: 'project', payload: updated });
    return updated;
  });
  app.get('/api/projects/:id/sync-rules', async request => {
    const { id } = identifier.parse(request.params);
    const project = projectFor(context, id, request.user.id);
    if (project.execution_mode === 'local') throw new HttpError(400, '本机项目直接使用实际目录，无需同步排除规则');
    let rules = project.sync_rules;
    if (rules === null) {
      try { rules = await readLegacyRules(ssh, request.user.id, hostFor(context, project.dev_host_id, request.user.id), project.remote_path) ?? ''; }
      catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
    }
    return { rules, defaults: DEFAULT_IGNORES };
  });
  app.put('/api/projects/:id/sync-rules', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    const { rules } = z.object({ rules: z.string().max(SYNC_RULES_LIMIT) }).parse(request.body);
    try { assertSyncRules(rules); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
    const userId = request.user.id;
    const prepared = await withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, userId);
      if (project.execution_mode === 'local') throw new HttpError(400, '本机项目直接使用实际目录，无需同步排除规则');
      if (project.sync_rules === rules) return { project };
      assertNotRebuilding(project);
      if (project.sync_status === 'PAUSED') throw new HttpError(409, '同步已暂停，请先在工作区点「立即同步」恢复');
      await assertProjectIdle(context, id);
      const host = hostFor(context, project.dev_host_id, userId);
      // The kept mirror is pruned against the remote, so it may not hold anything the remote has not received.
      try { await workspaces.assertSynced(project); }
      catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
      try { await migrateSyncRules(userId, host, project, rules); }
      catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      store.run("UPDATE projects SET sync_rules=?,sync_status='CREATING' WHERE id=?", rules, id);
      context.connections.revokeResource(`project:${id}`);
      return { host, project: projectFor(context, id, userId) };
    });
    const { host, project } = prepared;
    if (!host) return project;
    // New rules may include paths that were never synced, which can take as long as a first sync.
    void withResourceLocks(context, [`project:${id}`], async () => {
      try {
        await workspaces.create(userId, host, project, firstSyncTimeout);
        const health = await workspaces.status(project);
        store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?', health.status, project.execution_mode, id);
        events.emit(userId, { type: 'project', payload: projectFor(context, id, userId) });
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(userId, { type: 'project', payload: { id, sync_status: 'ERROR' } });
        events.emit(userId, { type: 'error', payload: { message: `项目「${project.name}」按新排除规则同步失败，可调整规则或在工作区重试同步：${error instanceof Error ? error.message : String(error)}` } });
      }
    }).catch(error => {
      store.run("UPDATE projects SET sync_status='ERROR' WHERE id=? AND sync_status='CREATING'", id);
      events.emit(userId, { type: 'project', payload: { id, sync_status: 'ERROR' } });
      request.log.error({ err: error, projectId: id }, '无法开始按新排除规则同步');
    });
    events.emit(userId, { type: 'project', payload: project });
    return reply.code(202).send(project);
  });
  app.delete('/api/projects/:id', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, request.user.id);
      // Child agents' worktree projects go with their master project, checkout and branch included.
      const worktreeProjects = store.all<Project>('SELECT * FROM projects WHERE parent_project_id=?', id);
      for (const item of [project, ...worktreeProjects]) await assertProjectIdle(context, item.id);
      for (const item of worktreeProjects) await context.worktrees?.release(item);
      if (project.parent_project_id) await context.worktrees?.release(project);
      else await workspaces.remove(project);
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
