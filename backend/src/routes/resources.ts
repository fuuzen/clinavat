import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertClientPath, vmTargetPath } from '../client-host/path-utils.js';
import { mapClientRpcError } from '../client-host/workspace-adapter.js';
import { type Context, assertProjectIdle, hostFor, projectFor, withResourceLocks } from '../context.js';
import { HttpError, type ClientDevice, type Host, type Project } from '../models.js';
import { DEFAULT_IGNORES, literalIgnore } from '../runtime/sync-policy.js';
import { SYNC_RULES_LIMIT, assertSyncRules, readLegacyRules, removeLegacyRules } from '../runtime/sync-rules.js';
import { assertIgnorePath } from '../runtime/sync-scan.js';
import { attachTerminal } from '../runtime/terminal.js';
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
  clientMode: z.enum(['direct', 'mirrored']).default('direct'),
  remotePath: z.string().min(1).max(4096).refine(value => !/[\0\n\r]/.test(value), '路径包含无效字符').optional(),
  ignorePaths: z.array(z.string().refine(path => { try { assertIgnorePath(path); return true; } catch { return false; } }, '排除路径无效')).max(50).default([]),
}).refine(input => input.source === 'new' || !!input.remotePath, { message: '请选择已有目录', path: ['remotePath'] });

const projectPatchInput = z.object({
  pathMode: z.enum(['auto', 'bwrap', 'symlink']).optional(),
  clientMode: z.enum(['direct', 'mirrored']).optional(),
}).refine(input => input.pathMode !== undefined || input.clientMode !== undefined, { message: '请提供要更新的配置项' });

export function resourceRoutes(app: FastifyInstance, context: Context) {
  hostRoutes(app, context);
  workspaceFileRoutes(app, context);
  const { store, ssh, workspaces, config, events } = context;

  function clientDeviceOf(hostId: string): ClientDevice {
    const device = store.get<ClientDevice>('SELECT * FROM client_devices WHERE dev_host_id=?', hostId);
    if (!device) throw new HttpError(404, '未找到对应的客户端设备信息');
    return device;
  }

  async function migrateSyncRules(userId: string, host: Host, project: Project, replacement?: string) {
    if (host.kind === 'client') {
      if (project.sync_rules === null) {
        project.sync_rules = replacement ?? '';
        store.run('UPDATE projects SET sync_rules=? WHERE id=?', project.sync_rules, project.id);
      }
      return;
    }
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
    WHERE projects.user_id=? AND (dev_hosts.kind IN ('ssh','client') OR ?='admin') ORDER BY projects.created_at`, request.user.id, request.user.role));

  app.post('/api/projects', async (request, reply) => {
    const input = projectInput.parse(request.body);
    const id = randomUUID();
    const userId = request.user.id;
    const created = await withResourceLocks(context, [`host:${input.devHostId}`, `project:${id}`], async () => {
      const host = hostFor(context, input.devHostId, userId);
      const local = host.kind === 'local';
      const isClient = host.kind === 'client';
      const localPath = local ? await localProjectPath(input.remotePath, input.source) : join(config.workspaceDir, `proj_${id}`);

      if (isClient) {
        if (!input.remotePath) throw new HttpError(400, '客户端项目请指定设备目录路径');
        const device = clientDeviceOf(host.id);
        let remotePath: string;
        try { remotePath = assertClientPath(device.platform, input.remotePath); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
        if (store.get('SELECT id FROM projects WHERE dev_host_id=? AND remote_path=?', host.id, remotePath)) {
          throw new HttpError(409, '该远端目录已创建项目');
        }
        if (input.source === 'new') {
          try { await context.clientWorkspaceAdapter.mkdir(host.id, remotePath, '', true); }
          catch (error) { throw mapClientRpcError(error); }
        }
        const clientMode = input.clientMode;
        const vmPath = clientMode === 'mirrored'
          ? vmTargetPath(device.platform, remotePath, localPath, [config.dataDir, config.workspaceDir])
          : null;
        const rules = clientMode === 'mirrored' ? input.ignorePaths.map(literalIgnore).join('\n') : '';
        const syncStatus = clientMode === 'direct' ? 'READY' : 'CREATING';
        const project: Project = {
          id, user_id: userId, dev_host_id: host.id, name: input.name, remote_path: remotePath, local_path: localPath,
          sync_name: `proj-${id}`, sync_status: syncStatus, created_at: new Date().toISOString(),
          path_mode: 'direct', execution_mode: null, client_mode: clientMode, vm_path: vmPath, sync_rules: rules,
        };
        store.run(
          `INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name,sync_status,path_mode,execution_mode,client_mode,vm_path,sync_rules)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, project.user_id, host.id, project.name, project.remote_path, project.local_path, project.sync_name,
          project.sync_status, project.path_mode, project.execution_mode, clientMode, vmPath, project.sync_rules,
        );
        return { host, project };
      }

      if (input.remotePath && !input.remotePath.startsWith('/')) {
        throw new HttpError(400, '请输入绝对路径');
      }
      const remotePath = local ? localPath : input.source === 'new' ? localPath : input.remotePath!;
      if (store.get('SELECT id FROM projects WHERE dev_host_id=? AND remote_path=?', host.id, remotePath)) throw new HttpError(409, '该远端目录已创建项目');
      if (input.ignorePaths.length && (local || input.source === 'new')) throw new HttpError(400, '仅连接已有远端目录时可以添加同步排除规则');
      let rules = '';
      if (!local && input.source === 'existing') {
        try {
          const legacy = await readLegacyRules(ssh, userId, host, remotePath);
          rules = [legacy?.trimEnd(), ...input.ignorePaths.map(literalIgnore)].filter(Boolean).join('\n');
          if (legacy !== null) await removeLegacyRules(ssh, userId, host, remotePath);
        } catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      }
      if (!local && input.source === 'new') {
        const made = await ssh.exec(userId, host, `set -e; umask 077; if [ -L ${shellQuote(config.workspaceDir)} ]; then printf '%s\\n' '远端工作区根目录不能是软链接' >&2; exit 73; fi; if [ ! -d ${shellQuote(config.workspaceDir)} ]; then mkdir -m 1777 -- ${shellQuote(config.workspaceDir)}; fi; mkdir -m 700 -- ${shellQuote(remotePath)}`);
        if (made.code !== 0) throw new HttpError(502, `无法新建远端项目目录：${made.stderr.trim()}`);
      }
      const project: Project = {
        id, user_id: userId, dev_host_id: host.id, name: input.name, remote_path: remotePath, local_path: localPath,
        sync_name: `proj-${id}`, sync_status: 'CREATING', created_at: new Date().toISOString(),
        path_mode: local || input.source === 'new' ? 'direct' : input.pathMode, execution_mode: local ? 'local' : null, sync_rules: rules,
      };
      store.run('INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name,path_mode,execution_mode,sync_rules) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id, project.user_id, host.id, project.name, project.remote_path, project.local_path, project.sync_name, project.path_mode, project.execution_mode, project.sync_rules);
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
    if (project.execution_mode === 'local' || (host.kind === 'client' && project.client_mode !== 'mirrored')) {
      const ready = projectFor(context, id, userId);
      events.emit(userId, { type: 'project', payload: ready });
      return reply.code(201).send(ready);
    }

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
    if (project.sync_status !== 'CREATING' || project.execution_mode === 'local' || workspaces.isClientDirect(project)) return null;
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
    const input = projectPatchInput.parse(request.body);
    return withResourceLocks(context, [`project:${id}`], async () => {
      const project = projectFor(context, id, request.user.id);
      if (project.execution_mode === 'local') throw new HttpError(400, '本机项目直接使用实际目录，无需配置路径映射');
      assertNotRebuilding(project);
      await assertProjectIdle(context, id);
      const host = hostFor(context, project.dev_host_id, request.user.id);

      if (host.kind === 'client') {
        if (!input.clientMode || input.pathMode !== undefined) {
          throw new HttpError(400, '客户端项目仅支持切换 clientMode（direct / mirrored）');
        }
        const currentMode = project.client_mode ?? 'direct';
        if (currentMode === input.clientMode) return project;
        const device = clientDeviceOf(host.id);
        context.connections.revokeResource(`project:${id}`);
        if (input.clientMode === 'direct') {
          await workspaces.remove(project);
          store.run("UPDATE projects SET client_mode='direct',vm_path=NULL,sync_status='READY',sync_skipped_links=NULL WHERE id=?", id);
          const updated = projectFor(context, id, request.user.id);
          events.emit(request.user.id, { type: 'project', payload: updated });
          return updated;
        }
        const vmPath = vmTargetPath(device.platform, project.remote_path, project.local_path, [config.dataDir, config.workspaceDir]);
        store.run("UPDATE projects SET client_mode='mirrored',vm_path=?,sync_status='CREATING',sync_rules=COALESCE(sync_rules,'') WHERE id=?", vmPath, id);
        const mirrored = projectFor(context, id, request.user.id);
        try {
          await workspaces.create(request.user.id, host, mirrored);
          const health = await workspaces.status(mirrored);
          store.run('UPDATE projects SET sync_status=? WHERE id=?', health.status, id);
          const updated = projectFor(context, id, request.user.id);
          events.emit(request.user.id, { type: 'project', payload: updated });
          return updated;
        } catch (error) {
          store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
          events.emit(request.user.id, { type: 'project', payload: { id, client_mode: 'mirrored', sync_status: 'ERROR' } });
          throw new HttpError(502, `切换为镜像同步模式失败，可稍后重试同步：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!input.pathMode || input.clientMode !== undefined) {
        throw new HttpError(400, 'SSH 项目仅支持修改 pathMode');
      }
      try { await migrateSyncRules(request.user.id, host, project); }
      catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      await workspaces.pause(project);
      context.connections.revokeResource(`project:${id}`);
      project.path_mode = input.pathMode;
      store.run("UPDATE projects SET path_mode=?,sync_status='PAUSED' WHERE id=?", input.pathMode, id);
      try {
        await workspaces.create(request.user.id, host, project);
        const health = await workspaces.status(project);
        store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?', health.status, project.execution_mode, id);
        const updated = projectFor(context, id, request.user.id);
        events.emit(request.user.id, { type: 'project', payload: updated });
        return updated;
      } catch (error) {
        store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", id);
        events.emit(request.user.id, { type: 'project', payload: { id, path_mode: input.pathMode, sync_status: 'ERROR' } });
        throw new HttpError(502, `路径模式更新失败，可调整后重试：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });

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
    if (workspaces.isClientDirect(project)) throw new HttpError(400, '客户端直连模式无需同步排除规则');
    let rules = project.sync_rules;
    if (rules === null) {
      const host = hostFor(context, project.dev_host_id, request.user.id);
      if (host.kind === 'client') rules = '';
      else {
        try { rules = await readLegacyRules(ssh, request.user.id, host, project.remote_path) ?? ''; }
        catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
      }
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
      if (workspaces.isClientDirect(project)) throw new HttpError(400, '客户端直连模式无需同步排除规则');
      if (project.sync_rules === rules) return { project };
      assertNotRebuilding(project);
      if (project.sync_status === 'PAUSED') throw new HttpError(409, '同步已暂停，请先在工作区点「立即同步」恢复');
      await assertProjectIdle(context, id);
      const host = hostFor(context, project.dev_host_id, userId);
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
      if (!['WATCHING', 'LOCAL', 'READY'].includes(current.sync_status)) throw new HttpError(409, '请先恢复项目同步');
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
        if (!['WATCHING', 'LOCAL', 'READY'].includes(current.sync_status)) throw new HttpError(409, '请先恢复项目同步');
        const unwatchProject = context.connections.watchResource(`project:${id}`, () => socket.close(1008, '项目或连接配置已变更'));
        socket.once('close', unwatchProject);
        await attachTerminal(socket, request.user.id, hostFor(context, current.dev_host_id, request.user.id), current, ssh, workspaces, {
          policy: context.targetPolicy,
          approvals: context.devHostApprovals,
          requirePrivateApproval: config.executionHost === 'lxd',
          isUserActive: userId => {
            const user = store.get<{ id: string; suspended_at: string | null }>(
              'SELECT id,suspended_at FROM users WHERE id=?', userId,
            );
            return !!user && user.suspended_at === null;
          },
        });
      }).catch(error => {
        socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })); socket.close();
      });
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })); socket.close();
    }
  });
}
