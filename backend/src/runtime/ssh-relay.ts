import { randomUUID } from 'node:crypto';
import { createServer, isIPv4, type AddressInfo, type Server, type Socket } from 'node:net';
import type { AccountCredentials } from '../accounts/credentials.js';
import type { Store } from '../database.js';
import type { MachineKind, MachinePlan } from '../execution/machine-plan.js';
import type { DevHostApprovalStore } from './dev-host-approvals.js';
import {
  destroyAndWait, normalizeRemoteIp, parsePreambleCommand, readPreamble, readSshBanner, writeErrorAndClose,
  type ParsedRelayCommand, type SshRelayHop,
} from './ssh-relay-protocol.js';
import { isPrivateIpv4, TargetPolicyError, type SshTargetPolicy } from './target-policy.js';

export type { SshRelayHop } from './ssh-relay-protocol.js';

export interface SshRelayLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface SshRelayOptions {
  bindHost?: string;
  vmBridge?: string;
  port: number;
  store: Store;
  machines: MachinePlan;
  credentials: AccountCredentials;
  approvals: DevHostApprovalStore;
  policy: SshTargetPolicy;
  logger?: SshRelayLogger;
  dialTimeoutMs?: number;
}

export interface ProbeTokenOptions {
  userId: string;
  pinnedIp: string;
  port: number;
  ttlMs?: number;
  maxUses?: number;
}

export interface SshRelayRevokeFilter {
  srcIp?: string;
  slotId?: string;
  userId?: string;
  devHostId?: string;
  pinnedIp?: string;
  port?: number;
}

export interface ActiveRelayConnectionInfo {
  id: string;
  srcIp: string;
  slotId?: string;
  userId: string;
  devHostId?: string;
  pinnedIp: string;
  port: number;
  epoch?: number;
  startedAt: number;
}

interface ActiveRelayConnection extends ActiveRelayConnectionInfo {
  clientSocket: Socket;
  upstreamSocket: Socket;
}

interface ProbeTokenEntry {
  userId: string;
  pinnedIp: string;
  port: number;
  expiresAt: number;
  remainingUses: number;
}

interface CallerContext {
  srcIp: string;
  machineKind: MachineKind;
  userId: string;
  slotId?: string;
  epoch?: number;
}

interface ResolvedTarget {
  pinnedIp: string;
  port: number;
  devHostId?: string;
  requiresApproval: boolean;
  hop?: SshRelayHop;
}

interface DevHostRow {
  id: string;
  user_id: string;
  kind: string;
  host: string;
  port: number;
  jump_host: string | null;
  jump_port: number | null;
}

const defaultProbeTtlMs = 60_000;
const noopLogger: SshRelayLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function relayBindHost(vmBridge: string): string {
  const host = vmBridge.split('/')[0]?.trim() ?? '';
  if (!isIPv4(host)) throw new Error(`无效的 VM 网桥地址：${vmBridge}`);
  return host;
}

export class SshRelayServer {
  readonly bindHost: string;
  readonly port: number;
  private readonly store: Store;
  private readonly machines: MachinePlan;
  private readonly credentials: AccountCredentials;
  private readonly approvals: DevHostApprovalStore;
  private readonly policy: SshTargetPolicy;
  private readonly logger: SshRelayLogger;
  private readonly dialTimeoutMs: number;
  private server?: Server;
  private readonly activeConnections = new Map<string, ActiveRelayConnection>();
  private readonly probeTokens = new Map<string, ProbeTokenEntry>();

  constructor(options: SshRelayOptions) {
    this.bindHost = options.bindHost ?? relayBindHost(options.vmBridge ?? '10.31.0.1/24');
    this.port = options.port;
    this.store = options.store;
    this.machines = options.machines;
    this.credentials = options.credentials;
    this.approvals = options.approvals;
    this.policy = options.policy;
    this.logger = options.logger ?? noopLogger;
    this.dialTimeoutMs = options.dialTimeoutMs ?? 10_000;
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      const addr = this.server.address() as AddressInfo | null;
      return Promise.resolve({ host: addr?.address ?? this.bindHost, port: addr?.port ?? this.port });
    }
    return new Promise((resolve, reject) => {
      const server = createServer(socket => { void this.handleConnection(socket); });
      server.once('error', error => {
        this.logger.error({ err: error, bindHost: this.bindHost, port: this.port }, 'SSH relay failed to start');
        reject(error);
      });
      server.listen(this.port, this.bindHost, () => {
        this.server = server;
        server.on('error', error => this.logger.error({ err: error }, 'SSH relay server error'));
        const addr = server.address() as AddressInfo;
        this.logger.info({ event: 'ssh_relay_start', host: addr.address, port: addr.port }, 'SSH relay listening');
        resolve({ host: addr.address, port: addr.port });
      });
    });
  }

  async stop(): Promise<void> {
    this.probeTokens.clear();
    const server = this.server;
    this.server = undefined;
    const closedServer = server ? new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      server.close(() => { clearTimeout(timer); resolve(); });
    }) : Promise.resolve();
    await this.revoke({}, 'server-stop');
    await closedServer;
  }

  registerProbeToken(token: string, entry: ProbeTokenOptions): void {
    this.sweepExpiredProbeTokens();
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(token)) throw new Error('无效的探测令牌格式');
    if (!isIPv4(entry.pinnedIp)) throw new Error('探测令牌目标必须是 IPv4 地址');
    if (!isPrivateIpv4(entry.pinnedIp)) throw new Error('探测令牌目标必须是私网 IPv4 地址');
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error('探测令牌端口无效');
    this.probeTokens.set(token, {
      userId: entry.userId,
      pinnedIp: entry.pinnedIp,
      port: entry.port,
      expiresAt: Date.now() + Math.max(1_000, entry.ttlMs ?? defaultProbeTtlMs),
      remainingUses: Math.max(1, entry.maxUses ?? 1),
    });
  }

  revokeProbeToken(token: string): void { this.probeTokens.delete(token); }
  activeCount(): number { return this.activeConnections.size; }
  listActive(): ActiveRelayConnectionInfo[] {
    return [...this.activeConnections.values()].map(({ clientSocket: _c, upstreamSocket: _u, ...info }) => info);
  }

  async revoke(filter: SshRelayRevokeFilter, reason: string): Promise<number> {
    const matched: ActiveRelayConnection[] = [];
    for (const conn of this.activeConnections.values()) {
      if (filter.srcIp !== undefined && conn.srcIp !== filter.srcIp) continue;
      if (filter.slotId !== undefined && conn.slotId !== filter.slotId) continue;
      if (filter.userId !== undefined && conn.userId !== filter.userId) continue;
      if (filter.devHostId !== undefined && conn.devHostId !== filter.devHostId) continue;
      if (filter.pinnedIp !== undefined && conn.pinnedIp !== filter.pinnedIp) continue;
      if (filter.port !== undefined && conn.port !== filter.port) continue;
      matched.push(conn);
    }
    if (!matched.length) return 0;

    for (const conn of matched) this.activeConnections.delete(conn.id);
    await Promise.all(matched.map(conn => Promise.all([
      destroyAndWait(conn.clientSocket),
      destroyAndWait(conn.upstreamSocket),
    ])));

    this.logger.info({
      event: 'ssh_relay_revoke', reason, filter, revokedCount: matched.length,
      connections: matched.map(conn => ({
        id: conn.id, srcIp: conn.srcIp, slotId: conn.slotId, userId: conn.userId,
        devHostId: conn.devHostId, pinnedIp: conn.pinnedIp, port: conn.port,
      })),
    }, 'SSH relay connections revoked');
    return matched.length;
  }

  private sweepExpiredProbeTokens(): void {
    const now = Date.now();
    for (const [token, entry] of this.probeTokens) {
      if (entry.expiresAt <= now || entry.remainingUses <= 0) this.probeTokens.delete(token);
    }
  }

  private authenticateCaller(clientSocket: Socket): { caller?: CallerContext; error?: string } {
    const srcIp = normalizeRemoteIp(clientSocket.remoteAddress);
    const machine = srcIp ? this.machines.byAddress(srcIp) : null;
    if (!srcIp || !machine) return { error: 'unauthorized source' };

    if (machine.kind === 'slot') {
      if (!this.credentials.isRecovered()) return { error: 'slot lease state not recovered' };
      const auth = this.credentials.slotAuthState(machine.ownerId);
      if (!auth.userId) return { error: 'slot has no active lease' };
      if (!this.isUserActive(auth.userId)) return { error: 'user unavailable or suspended' };
      return { caller: { srcIp, machineKind: 'slot', userId: auth.userId, slotId: machine.ownerId, epoch: auth.epoch } };
    }
    if (!this.isUserActive(machine.ownerId)) return { error: 'user unavailable or suspended' };
    return { caller: { srcIp, machineKind: 'workspace', userId: machine.ownerId } };
  }

  private isUserActive(userId: string): boolean {
    const user = this.store.get<{ id: string; suspended_at: string | null }>(
      'SELECT id,suspended_at FROM users WHERE id=?', userId,
    );
    return !!user && user.suspended_at === null;
  }

  private isCallerStillAuthorized(caller: CallerContext, pinnedIp: string, port: number, requiresApproval: boolean): boolean {
    if (!this.isUserActive(caller.userId)) return false;
    if (caller.machineKind === 'slot' && caller.slotId) {
      if (!this.credentials.isRecovered()) return false;
      const current = this.credentials.slotAuthState(caller.slotId);
      if (current.userId !== caller.userId || current.epoch !== caller.epoch) return false;
    }
    return !requiresApproval || !!this.approvals.findApproved(caller.userId, pinnedIp, port);
  }

  private async resolveTarget(caller: CallerContext, command: ParsedRelayCommand): Promise<ResolvedTarget> {
    if (command.type === 'probe') {
      this.sweepExpiredProbeTokens();
      const entry = this.probeTokens.get(command.token);
      if (!entry || entry.userId !== caller.userId || entry.remainingUses <= 0 || entry.expiresAt <= Date.now()) {
        throw new Error('invalid or expired probe token');
      }
      if (!isPrivateIpv4(entry.pinnedIp)) {
        throw new Error('relay only forwards approved private first hops');
      }
      await this.policy.assertNotDenied(entry.pinnedIp);
      if (!this.approvals.findApproved(caller.userId, entry.pinnedIp, entry.port)) {
        throw new Error('private target not approved');
      }
      entry.remainingUses -= 1;
      if (entry.remainingUses <= 0) this.probeTokens.delete(command.token);
      return { pinnedIp: entry.pinnedIp, port: entry.port, requiresApproval: true };
    }

    const host = this.store.get<DevHostRow>(
      "SELECT id,user_id,kind,host,port,jump_host,jump_port FROM dev_hosts WHERE id=? AND user_id=? AND kind='ssh'",
      command.hostId, caller.userId,
    );
    if (!host) throw new Error('unknown host');

    const hasJump = !!host.jump_host?.trim();
    const expectedHop: SshRelayHop = hasJump ? 'jump' : 'target';
    if (command.hop !== expectedHop) {
      throw new Error(hasJump ? 'hop must be jump when jump host is configured' : 'jump host not configured');
    }

    const hostname = expectedHop === 'jump' ? host.jump_host : host.host;
    const port = expectedHop === 'jump' ? host.jump_port : host.port;
    if (!hostname || !port) throw new Error('invalid target configuration');

    const classified = await this.policy.classifyTarget(hostname, port);
    if (classified.kind !== 'private') {
      throw new Error('relay only forwards approved private first hops');
    }
    if (!this.approvals.findApproved(caller.userId, classified.pinnedIp, classified.port)) {
      throw new Error('private target not approved');
    }
    return { pinnedIp: classified.pinnedIp, port: classified.port, devHostId: host.id, requiresApproval: true, hop: command.hop };
  }

  private async handleConnection(clientSocket: Socket): Promise<void> {
    clientSocket.on('error', () => undefined);
    const deny = (meta: Record<string, unknown>, reason: string, msg: string) => {
      this.logger.warn({ event: 'ssh_relay_deny', ...meta, reason }, msg);
      writeErrorAndClose(clientSocket, reason);
    };

    const auth = this.authenticateCaller(clientSocket);
    if (!auth.caller) return deny({ srcIp: clientSocket.remoteAddress }, auth.error ?? 'unauthorized source', 'SSH relay denied source');
    const caller = auth.caller;

    let preamble: { line: string; leftover: Buffer };
    try { preamble = await readPreamble(clientSocket); }
    catch (error) { return deny({ srcIp: caller.srcIp, userId: caller.userId }, error instanceof Error ? error.message : 'invalid preamble', 'SSH relay preamble failed'); }

    const command = parsePreambleCommand(preamble.line);
    if (!command) return deny({ srcIp: caller.srcIp, userId: caller.userId }, 'invalid command', 'SSH relay invalid command');

    let target: ResolvedTarget;
    try { target = await this.resolveTarget(caller, command); }
    catch (error) {
      const reason = error instanceof TargetPolicyError || error instanceof Error ? error.message : 'target rejected';
      return deny({ srcIp: caller.srcIp, slotId: caller.slotId, userId: caller.userId, mode: command.type }, reason, 'SSH relay target denied');
    }

    let upstreamSocket: Socket;
    try { upstreamSocket = await this.policy.dialAuthorizedTcp(target.pinnedIp, target.port, this.dialTimeoutMs); }
    catch (error) {
      return deny({
        srcIp: caller.srcIp, slotId: caller.slotId, userId: caller.userId,
        devHostId: target.devHostId, pinnedIp: target.pinnedIp, port: target.port,
      }, error instanceof Error ? error.message : 'upstream connect failed', 'SSH relay upstream dial failed');
    }
    upstreamSocket.on('error', () => undefined);

    if (clientSocket.destroyed || !this.isCallerStillAuthorized(caller, target.pinnedIp, target.port, target.requiresApproval)) {
      upstreamSocket.destroy();
      return deny({
        srcIp: caller.srcIp, slotId: caller.slotId, userId: caller.userId,
        devHostId: target.devHostId, pinnedIp: target.pinnedIp, port: target.port,
      }, 'authorization changed', 'SSH relay lease changed during dial');
    }

    const conn: ActiveRelayConnection = {
      id: randomUUID(), srcIp: caller.srcIp, slotId: caller.slotId, userId: caller.userId,
      devHostId: target.devHostId, pinnedIp: target.pinnedIp, port: target.port,
      epoch: caller.epoch, startedAt: Date.now(), clientSocket, upstreamSocket,
    };
    this.activeConnections.set(conn.id, conn);

    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      const wasActive = this.activeConnections.delete(conn.id);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      if (wasActive) {
        this.logger.info({
          event: 'ssh_relay_close', id: conn.id, srcIp: conn.srcIp, slotId: conn.slotId, userId: conn.userId,
          devHostId: conn.devHostId, pinnedIp: conn.pinnedIp, port: conn.port, durationMs: Date.now() - conn.startedAt,
        }, 'SSH relay connection closed');
      }
    };
    const abortAfterDial = (reason: string, msg: string) => {
      closed = true;
      clientSocket.off('close', teardown);
      upstreamSocket.off('close', teardown);
      this.activeConnections.delete(conn.id);
      upstreamSocket.destroy();
      deny({
        id: conn.id, srcIp: conn.srcIp, slotId: conn.slotId, userId: conn.userId,
        devHostId: conn.devHostId, pinnedIp: conn.pinnedIp, port: conn.port,
      }, reason, msg);
    };
    clientSocket.once('close', teardown);
    upstreamSocket.once('close', teardown);

    let bannerBytes: Buffer;
    try { bannerBytes = await readSshBanner(upstreamSocket); }
    catch (error) {
      return abortAfterDial(error instanceof Error ? error.message : 'target is not an SSH service', 'SSH relay banner gate rejected target');
    }

    if (clientSocket.destroyed || upstreamSocket.destroyed || !this.activeConnections.has(conn.id)
      || !this.isCallerStillAuthorized(caller, target.pinnedIp, target.port, target.requiresApproval)) {
      return abortAfterDial('authorization changed', 'SSH relay authorization changed during banner');
    }

    this.logger.info({
      event: 'ssh_relay_connect', id: conn.id, srcIp: conn.srcIp, machineKind: caller.machineKind,
      slotId: conn.slotId, userId: conn.userId, devHostId: conn.devHostId, hop: target.hop,
      pinnedIp: conn.pinnedIp, port: conn.port, mode: command.type,
    }, 'SSH relay connected');

    clientSocket.write('OK\n');
    clientSocket.write(bannerBytes);
    if (preamble.leftover.length) upstreamSocket.write(preamble.leftover);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.resume();
    upstreamSocket.resume();
  }
}
