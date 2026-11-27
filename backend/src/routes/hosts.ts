import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Context, assertProjectIdle, hostFor, withResourceLocks } from '../context.js';
import { HttpError, type Host, type Project } from '../models.js';
import { isValidSshHost, isValidSshUsername } from '../runtime/types.js';
import { mapClientRpcError } from '../client-host/workspace-adapter.js';
import { ensureLocalHost } from '../local-host.js';
import { localDirectories } from './local-projects.js';
import { readLegacyRules } from '../runtime/sync-rules.js';
import { scanSyncCandidates } from '../runtime/sync-scan.js';
import { TargetPolicyError, type ClassifiedTarget } from '../runtime/target-policy.js';
import { revokeSockets as revokeTerminalSockets } from '../runtime/terminal.js';

const identifier = z.object({ id: z.uuid() });
const portInput = z.coerce.number().int().min(1).max(65535);
const endpointFields = {
  host: z.string().trim().min(1).max(253).refine(isValidSshHost, '请输入有效的域名或 IP 地址，用户名和端口请分别填写'),
  port: portInput.default(22),
  username: z.string().trim().min(1).max(64).refine(isValidSshUsername, 'SSH 用户名格式无效'),
  privateKey: z.string().trim().min(1).max(65536).optional(),
};
const hostInput = z.object({
  name: z.string().trim().min(1).max(100),
  ...endpointFields,
  jumpHost: z.object(endpointFields).nullable().optional(),
});
const hostPatch = hostInput.partial().extend({ port: portInput.optional() });
const hostTestInput = hostInput.omit({ name: true }).extend({ hostId: z.uuid().optional() });

const pendingApprovalSaveMessage =
  '该内网开发机尚未获得管理员审批，已提交审批申请，请联系管理员在「网关 / 内网开发机审批」面板批准后再连接。';

// Connection failures are reported as 422 so reverse proxies pass the SSH output through instead of their own 5xx pages.
function connectionFailure(error: unknown): HttpError {
  return new HttpError(422, error instanceof Error ? error.message : String(error));
}

function mapTargetPolicyError(error: TargetPolicyError): HttpError {
  const statusCode = error.reason === 'dns_failed' ? error.statusCode : 400;
  return new HttpError(statusCode, error.message);
}

function firstHopOf(host: Pick<Host, 'host' | 'port' | 'jump_host' | 'jump_port'>): { hop: 'target' | 'jump'; host: string; port: number } {
  return host.jump_host
    ? { hop: 'jump', host: host.jump_host, port: host.jump_port! }
    : { hop: 'target', host: host.host, port: host.port };
}

async function classifyForSave(context: Context, host: Pick<Host, 'host' | 'port' | 'jump_host' | 'jump_port'>): Promise<ClassifiedTarget | undefined> {
  const first = firstHopOf(host);
  try {
    return await context.targetPolicy.classifyTarget(first.host, first.port);
  } catch (error) {
    if (error instanceof TargetPolicyError) {
      if (error.reason === 'dns_failed') return undefined;
      throw mapTargetPolicyError(error);
    }
    throw error;
  }
}

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

async function revokeHostApprovals(
  context: Context,
  userId: string,
  devHostId: string,
  relayReason: string,
  note: string,
): Promise<void> {
  const revoked = context.devHostApprovals.revokeByHost(userId, devHostId, note);
  for (const approval of revoked) {
    await context.sshRelay.revoke(
      { userId, pinnedIp: approval.pinned_ip, port: approval.port },
      relayReason,
    );
    revokeTerminalSockets(
      { userId, pinnedIp: approval.pinned_ip, port: approval.port },
      note,
    );
  }
}

export interface HostWithClientDeviceRow extends Host {
  device_id: string | null;
  device_platform: string | null;
  device_arch: string | null;
  device_os_version: string | null;
  device_default_shell: string | null;
  device_homedir: string | null;
  device_last_seen_at: string | null;
}

export function serializeHost(context: Context, row: HostWithClientDeviceRow) {
  const {
    device_id, device_platform, device_arch, device_os_version,
    device_default_shell, device_homedir, device_last_seen_at, ...host
  } = row;
  if (host.kind !== 'client') return host;
  const online = context.clientHostRegistry.isOnline(host.id);
  return {
    ...host,
    status: online ? 'CONNECTED' : host.status,
    device: device_id ? {
      id: device_id,
      platform: device_platform ?? '',
      arch: device_arch ?? '',
      os_version: device_os_version ?? '',
      default_shell: device_default_shell ?? '',
      homedir: device_homedir ?? '',
      last_seen_at: device_last_seen_at,
      online,
    } : null,
  };
}

export function listVisibleHosts(context: Context, userId: string, role: string) {
  const rows = context.store.all<HostWithClientDeviceRow>(
    `SELECT h.*, d.id AS device_id, d.platform AS device_platform, d.arch AS device_arch,
            d.os_version AS device_os_version, d.default_shell AS device_default_shell,
            d.homedir AS device_homedir, d.last_seen_at AS device_last_seen_at
     FROM dev_hosts h
     LEFT JOIN client_devices d ON d.dev_host_id = h.id
     WHERE h.user_id=? AND (h.kind IN ('ssh','client') OR ?='admin')
     ORDER BY h.kind, h.created_at`,
    userId, role,
  );
  return rows.map(row => serializeHost(context, row));
}

export function hostRoutes(app: FastifyInstance, context: Context) {
  const { store, ssh, events, sshRelay, devHostApprovals, clientHostRegistry, clientSsh } = context;
  app.get('/api/hosts', async request => {
    if (request.user.role === 'admin') ensureLocalHost(store, request.user.id);
    return listVisibleHosts(context, request.user.id, request.user.role);
  });
  app.post('/api/hosts', async (request, reply) => {
    const input = hostInput.parse(request.body);
    return withResourceLocks(context, [`user-hosts:${request.user.id}`], async () => {
      const host: Host = {
        id: randomUUID(), user_id: request.user.id, name: input.name, host: input.host,
        port: input.port, username: input.username, status: 'DISCONNECTED',
        kind: 'ssh', created_at: new Date().toISOString(), ...jumpFields(input.jumpHost),
      };
      const classified = await classifyForSave(context, host);
      await validateKeys(context, request.user.id, [input.privateKey, input.jumpHost?.privateKey]);
      try {
        await ssh.addHost(request.user.id, host, input.privateKey, input.jumpHost?.privateKey,
          classified ? { useRelay: classified.kind === 'private' } : undefined);
        store.run('INSERT INTO dev_hosts(id,user_id,name,host,port,username,jump_host,jump_port,jump_username) VALUES(?,?,?,?,?,?,?,?,?)',
          host.id, host.user_id, host.name, host.host, host.port, host.username,
          host.jump_host ?? null, host.jump_port ?? null, host.jump_username ?? null);
      } catch (error) {
        await ssh.deleteHost(request.user.id, host).catch(() => undefined);
        throw new HttpError(400, `无法保存 SSH 配置：${error instanceof Error ? error.message : String(error)}`);
      }
      if (classified?.kind === 'private') {
        const first = firstHopOf(host);
        const approval = devHostApprovals.requestOrGet({
          userId: request.user.id, devHostId: host.id, hop: first.hop,
          hostname: first.host, pinnedIp: classified.pinnedIp, port: classified.port,
        });
        if (approval.status !== 'approved') {
          return reply.code(201).send({ ...host, pendingApproval: true, approval, message: pendingApprovalSaveMessage });
        }
      }
      return reply.code(201).send(host);
    });
  });
  app.patch('/api/hosts/:id', async request => {
    const { id } = identifier.parse(request.params);
    const input = hostPatch.parse(request.body);
    const existingHost = hostFor(context, id, request.user.id);
    if (existingHost.kind === 'local') throw new HttpError(403, '本机开发机为固定连接，不能修改');
    if (existingHost.kind === 'client') {
      const hasUnsupportedFields = input.host !== undefined || input.port !== undefined || input.username !== undefined
        || input.privateKey !== undefined || input.jumpHost !== undefined;
      if (hasUnsupportedFields) throw new HttpError(400, '客户端设备连接参数由客户端自动维护，仅支持修改名称');
      return withResourceLocks(context, [`host:${id}`, `user-hosts:${request.user.id}`], () => {
        if (input.name !== undefined) store.run("UPDATE dev_hosts SET name=? WHERE id=? AND kind='client'", input.name, id);
        const row = store.get<HostWithClientDeviceRow>(
          `SELECT h.*, d.id AS device_id, d.platform AS device_platform, d.arch AS device_arch,
                  d.os_version AS device_os_version, d.default_shell AS device_default_shell,
                  d.homedir AS device_homedir, d.last_seen_at AS device_last_seen_at
           FROM dev_hosts h LEFT JOIN client_devices d ON d.dev_host_id = h.id WHERE h.id=? AND h.user_id=?`,
          id, request.user.id,
        )!;
        return serializeHost(context, row);
      });
    }
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
      const targetChanged = (['host', 'port', 'jump_host', 'jump_port'] as const)
        .some(field => (host[field] ?? null) !== (previous[field] ?? null));
      const previousFirstHop = firstHopOf(previous);
      const nextFirstHop = firstHopOf(host);
      const firstHopChanged = previousFirstHop.hop !== nextFirstHop.hop
        || previousFirstHop.host !== nextFirstHop.host
        || previousFirstHop.port !== nextFirstHop.port;
      const changed = targetChanged || !!input.privateKey || !!input.jumpHost?.privateKey
        || (['username', 'jump_username'] as const).some(field => (host[field] ?? null) !== (previous[field] ?? null));
      if (!changed) {
        store.run('UPDATE dev_hosts SET name=? WHERE id=?', host.name, id);
        return hostFor(context, id, request.user.id);
      }
      const classified = targetChanged ? await classifyForSave(context, host) : undefined;
      for (const project of projects) await assertProjectIdle(context, project.id);
      await validateKeys(context, request.user.id, [input.privateKey, input.jumpHost?.privateKey]);
      try {
        for (const project of projects) {
          await context.workspaces.pause(project);
          store.run("UPDATE projects SET sync_status='PAUSED' WHERE id=?", project.id);
          events.emit(request.user.id, { type: 'project', payload: { id: project.id, sync_status: 'PAUSED' } });
          context.connections.revokeResource(`project:${project.id}`);
        }
        await sshRelay.revoke({ userId: request.user.id, devHostId: id }, 'host_updated');
        revokeTerminalSockets({ userId: request.user.id, devHostId: id }, '开发机连接配置已修改');
        await ssh.disconnectHost(request.user.id, previous);
        await ssh.addHost(request.user.id, host, input.privateKey, input.jumpHost?.privateKey,
          classified ? { useRelay: classified.kind === 'private' } : undefined);
        if (firstHopChanged) {
          await revokeHostApprovals(context, request.user.id, id, 'host_target_changed', '开发机目标地址或端口已变更');
        }
        store.run("UPDATE dev_hosts SET name=?,host=?,port=?,username=?,jump_host=?,jump_port=?,jump_username=?,status='DISCONNECTED' WHERE id=?",
          host.name, host.host, host.port, host.username, host.jump_host ?? null,
          host.jump_port ?? null, host.jump_username ?? null, id);
      } catch (error) {
        await ssh.addHost(request.user.id, previous).catch(() => undefined);
        throw new HttpError(502, `SSH 配置更新失败，项目同步已暂停，可检查后重试：${error instanceof Error ? error.message : String(error)}`);
      }
      const updated = hostFor(context, id, request.user.id);
      if (targetChanged && classified?.kind === 'private') {
        const first = firstHopOf(updated);
        const approval = devHostApprovals.requestOrGet({
          userId: request.user.id, devHostId: updated.id, hop: first.hop,
          hostname: first.host, pinnedIp: classified.pinnedIp, port: classified.port,
        });
        if (approval.status !== 'approved') {
          return { ...updated, pendingApproval: true, approval, message: pendingApprovalSaveMessage };
        }
      }
      return updated;
    });
  });
  app.post('/api/hosts/:id/connect', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`host:${id}`], async () => {
      const host = hostFor(context, id, request.user.id);
      if (host.kind === 'local') return { ok: true, status: 'CONNECTED', fingerprint: '' };
      if (host.kind === 'client') {
        if (!clientHostRegistry.isOnline(id)) throw new HttpError(409, '客户端设备由本地客户端主动连接，当前不在线');
        return { ok: true, status: 'CONNECTED', fingerprint: clientSsh.getHostKeyFingerprint() };
      }
      try {
        const result = await ssh.connect(request.user.id, host);
        if (result.pendingApproval) {
          return reply.code(403).send({ error: result.message, ...result });
        }
        store.run("UPDATE dev_hosts SET status='CONNECTED' WHERE id=?", id);
        return result;
      } catch (error) {
        if (error instanceof TargetPolicyError) throw mapTargetPolicyError(error);
        store.run("UPDATE dev_hosts SET status='ERROR' WHERE id=?", id);
        throw connectionFailure(error);
      }
    });
  });
  // Tests the settings in the host dialog before they are saved; a saved host lends the keys the dialog keeps.
  app.post('/api/hosts/test', async request => {
    const input = hostTestInput.parse(request.body);
    const saved = input.hostId ? hostFor(context, input.hostId, request.user.id) : undefined;
    if (saved?.kind === 'local') throw new HttpError(400, '本机开发机为固定连接，无需测试');
    if (saved?.kind === 'client') throw new HttpError(400, '客户端设备由本地客户端主动连接，无需 SSH 连接测试');
    await validateKeys(context, request.user.id, [input.privateKey, input.jumpHost?.privateKey]);
    const host = {
      id: saved?.id ?? randomUUID(), user_id: request.user.id, name: saved?.name ?? '连接测试',
      host: input.host, port: input.port, username: input.username, ...jumpFields(input.jumpHost),
    };
    try {
      return await ssh.probe(request.user.id, host, {
        privateKey: input.privateKey, jumpPrivateKey: input.jumpHost?.privateKey, savedHostId: saved?.id,
      });
    } catch (error) {
      if (error instanceof TargetPolicyError) throw mapTargetPolicyError(error);
      throw connectionFailure(error);
    }
  });
  app.get('/api/hosts/:id/directories', async request => {
    const { id } = identifier.parse(request.params);
    const { path } = z.object({ path: z.string().max(4096).optional() }).parse(request.query);
    const requestedPath = path?.trim() || undefined;
    return withResourceLocks(context, [`host:${id}`], async () => {
      const host = hostFor(context, id, request.user.id);
      if (host.kind === 'client') {
        try { return await context.clientWorkspaceAdapter.listDirectories(host.id, requestedPath); }
        catch (error) { throw mapClientRpcError(error); }
      }
      return host.kind === 'local' ? localDirectories(requestedPath ?? homedir()) : ssh.listDirectories(request.user.id, host, requestedPath);
    });
  });
  app.post('/api/hosts/:id/sync-scan', async request => {
    const { id } = identifier.parse(request.params);
    const { remotePath } = z.object({ remotePath: z.string().min(1).max(4096) }).parse(request.body);
    return withResourceLocks(context, [`host:${id}`], async () => {
      const host = hostFor(context, id, request.user.id);
      if (host.kind === 'local') throw new HttpError(400, '本机项目直接使用实际目录，无需同步扫描');
      if (host.kind === 'client') throw new HttpError(400, '客户端设备暂不支持 SSH 同步扫描');
      try {
        const rules = await readLegacyRules(ssh, request.user.id, host, remotePath) ?? '';
        return await scanSyncCandidates(context.config, ssh, request.user.id, host, remotePath, rules);
      }
      catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
    });
  });
  app.delete('/api/hosts/:id', async request => {
    const { id } = identifier.parse(request.params);
    return withResourceLocks(context, [`host:${id}`, `user-hosts:${request.user.id}`], async () => {
      const host = hostFor(context, id, request.user.id);
      if (host.kind === 'local') throw new HttpError(403, '本机开发机为固定连接，不能删除');
      if (store.get('SELECT id FROM projects WHERE dev_host_id=?', id)) throw new HttpError(409, '请先删除开发机下的项目');
      if (host.kind === 'client') {
        clientHostRegistry.disconnectHost(id, 'host_deleted');
        revokeTerminalSockets({ userId: request.user.id, devHostId: id }, '开发机已删除');
        store.run('DELETE FROM dev_hosts WHERE id=?', id);
        return { ok: true };
      }
      await sshRelay.revoke({ userId: request.user.id, devHostId: id }, 'host_deleted');
      revokeTerminalSockets({ userId: request.user.id, devHostId: id }, '开发机已删除');
      await revokeHostApprovals(context, request.user.id, id, 'host_deleted', '开发机已删除');
      await ssh.deleteHost(request.user.id, host);
      store.run('DELETE FROM dev_hosts WHERE id=?', id);
      return { ok: true };
    });
  });
}
