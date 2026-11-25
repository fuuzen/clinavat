import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import type { Context } from '../context.js';
import type { Host } from '../models.js';
import type { DevHostApproval } from '../runtime/dev-host-approvals.js';
import { revokeSockets as revokeTerminalSockets } from '../runtime/terminal.js';

const identifier = z.object({ id: z.uuid() });
const statusQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'revoked']).optional(),
});
const decisionBody = z.object({
  note: z.string().trim().max(500).optional(),
}).strict();

async function refreshApprovedHosts(context: Context, approval: DevHostApproval): Promise<void> {
  const { store, ssh } = context;
  const targets = new Map<string, Host>();
  if (approval.dev_host_id) {
    const direct = store.get<Host>(
      "SELECT * FROM dev_hosts WHERE id=? AND user_id=? AND kind='ssh'",
      approval.dev_host_id, approval.user_id,
    );
    if (direct) targets.set(direct.id, direct);
  }
  const matching = approval.hop === 'jump'
    ? store.all<Host>(
      "SELECT * FROM dev_hosts WHERE user_id=? AND kind='ssh' AND jump_host IN (?,?) AND jump_port=?",
      approval.user_id, approval.hostname, approval.pinned_ip, approval.port,
    )
    : store.all<Host>(
      "SELECT * FROM dev_hosts WHERE user_id=? AND kind='ssh' AND jump_host IS NULL AND host IN (?,?) AND port=?",
      approval.user_id, approval.hostname, approval.pinned_ip, approval.port,
    );
  for (const host of matching) targets.set(host.id, host);
  for (const host of targets.values()) {
    await ssh.addHost(approval.user_id, host, undefined, undefined, { useRelay: true });
  }
}

export function adminDevHostRoutes(app: FastifyInstance, context: Context) {
  const { config, devHostApprovals, sshRelay } = context;

  app.get('/api/admin/dev-host-approvals', async request => {
    requireAdmin(request);
    const { status } = statusQuery.parse(request.query);
    return {
      approvals: devHostApprovals.list(status ? { status } : undefined),
      relay: {
        enabled: config.executionHost === 'lxd',
        port: config.sshRelayPort,
        activeConnections: sshRelay.activeCount(),
      },
    };
  });

  app.post('/api/admin/dev-host-approvals/:id/approve', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    const { note } = decisionBody.parse(request.body ?? {});
    const decided = devHostApprovals.approve(id, request.user.id, note);
    await refreshApprovedHosts(context, decided);
    return { approval: devHostApprovals.get(decided.id)! };
  });

  app.post('/api/admin/dev-host-approvals/:id/reject', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    const { note } = decisionBody.parse(request.body ?? {});
    const decided = devHostApprovals.reject(id, request.user.id, note);
    const relayDisconnected = await sshRelay.revoke(
      { userId: decided.user_id, pinnedIp: decided.pinned_ip, port: decided.port },
      'approval_rejected',
    );
    const terminalDisconnected = revokeTerminalSockets(
      { userId: decided.user_id, pinnedIp: decided.pinned_ip, port: decided.port },
      '内网开发机访问审批已被拒绝',
    );
    return {
      approval: devHostApprovals.get(decided.id)!,
      disconnected: relayDisconnected + terminalDisconnected,
    };
  });

  app.post('/api/admin/dev-host-approvals/:id/revoke', async request => {
    requireAdmin(request);
    const { id } = identifier.parse(request.params);
    const { note } = decisionBody.parse(request.body ?? {});
    const decided = devHostApprovals.revoke(id, request.user.id, note);
    const relayDisconnected = await sshRelay.revoke(
      { userId: decided.user_id, pinnedIp: decided.pinned_ip, port: decided.port },
      'approval_revoked',
    );
    const terminalDisconnected = revokeTerminalSockets(
      { userId: decided.user_id, pinnedIp: decided.pinned_ip, port: decided.port },
      '内网开发机访问审批已被撤销',
    );
    return {
      approval: devHostApprovals.get(decided.id)!,
      disconnected: relayDisconnected + terminalDisconnected,
    };
  });
}
