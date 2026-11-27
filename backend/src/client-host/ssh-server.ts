import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import ssh2, { type Connection as SshServerConnection, type ParsedKey, type Server as Ssh2Server } from 'ssh2';
import { createWebSocketStream, type WebSocket } from 'ws';
import type { Store } from '../database.js';
import type { KeyStore } from '../runtime/keys.js';
import { atomicWrite } from '../runtime/process.js';
import { Multiplexer } from './protocol.js';
import type { ClientHostRegistry } from './registry.js';

const AGENT_EXEC_COMMAND = 'clinavat-agent-v1';
const DEVICE_USERNAME_PATTERN = /^device:([A-Za-z0-9._-]{1,128})$/;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 16;
const DEFAULT_MAX_PRE_AUTH_CONNECTIONS = 64;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface ClientSshLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ClientSshServerOptions {
  dataDir: string;
  port: number;
  host?: string;
  bindHost?: string;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  maxPreAuthConnections?: number;
  handshakeTimeoutMs?: number;
  store: Store;
  keyStore: KeyStore;
  registry: ClientHostRegistry;
  logger?: ClientSshLogger;
}

interface AuthenticatedDeviceRow {
  device_id: string;
  host_id: string;
  user_id: string;
  public_key: string;
  platform: string;
  arch: string;
  os_version: string;
  default_shell: string;
  homedir: string;
}

type SshConnectionWithSocket = SshServerConnection & { _sock?: Duplex };

const noopLogger: ClientSshLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function sshPublicKeyFingerprint(parsed: ParsedKey): string {
  const digest = createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function parseEd25519PublicBytes(publicKey: string): Buffer | null {
  const parsed = ssh2.utils.parseKey(publicKey);
  if (parsed instanceof Error || parsed.isPrivateKey() || parsed.type !== 'ssh-ed25519') return null;
  return parsed.getPublicSSH();
}

function normalizeRemoteIp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip === 'localhost' || /^127\./.test(ip);
}

export class ClientSshServer {
  private readonly bindHost: string;
  private readonly configuredPort: number;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerIp: number;
  private readonly maxPreAuthConnections: number;
  private readonly handshakeTimeoutMs: number;
  private readonly logger: ClientSshLogger;
  private sshServer?: Ssh2Server;
  private tcpServer?: TcpServer;
  private boundPort?: number;
  private hostKeyFingerprint = '';
  private stopping = false;
  private readonly rawSockets = new Set<Duplex>();
  private readonly preAuthSockets = new Set<Duplex>();
  private readonly connectionsPerIp = new Map<string, number>();
  private readonly handshakeTimers = new Map<Duplex, ReturnType<typeof setTimeout>>();
  private readonly activeClients = new Set<SshServerConnection>();

  constructor(private readonly options: ClientSshServerOptions) {
    this.bindHost = options.host ?? options.bindHost ?? '127.0.0.1';
    this.configuredPort = options.port;
    this.maxConnections = Math.max(1, options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    this.maxConnectionsPerIp = Math.max(1, options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP);
    this.maxPreAuthConnections = Math.max(1, options.maxPreAuthConnections ?? DEFAULT_MAX_PRE_AUTH_CONNECTIONS);
    this.handshakeTimeoutMs = Math.max(100, options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.logger = options.logger ?? noopLogger;
  }

  getPort(): number { return this.boundPort ?? this.configuredPort; }
  getHostKeyFingerprint(): string { return this.hostKeyFingerprint; }

  async start(): Promise<{ host: string; port: number; hostKeyFingerprint: string }> {
    if (this.tcpServer && this.boundPort !== undefined) {
      return { host: this.bindHost, port: this.boundPort, hostKeyFingerprint: this.hostKeyFingerprint };
    }
    this.stopping = false;
    const { hostKeyPem, fingerprint } = await this.loadOrCreateHostKey();
    this.hostKeyFingerprint = fingerprint;

    this.sshServer = new ssh2.Server(
      {
        hostKeys: [hostKeyPem],
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        // ssh2 automatically prepends "SSH-2.0-" when sending the identification string.
        ident: 'ClinavatClientHost_1.0',
      },
      client => this.handleClient(client),
    );
    this.sshServer.on('error', (error: Error) => this.logger.error({ err: error }, '客户端 SSH 协议服务错误'));

    const tcpServer = createServer(socket => { this.acceptRawSocket(socket, socket.remoteAddress); });
    return new Promise((resolve, reject) => {
      tcpServer.once('error', (error: Error) => {
        this.logger.error({ err: error, bindHost: this.bindHost, port: this.configuredPort }, '客户端 SSH 服务端启动失败');
        reject(error);
      });
      tcpServer.listen(this.configuredPort, this.bindHost, () => {
        this.tcpServer = tcpServer;
        const addr = tcpServer.address() as AddressInfo;
        this.boundPort = addr.port;
        tcpServer.on('error', (error: Error) => this.logger.error({ err: error }, '客户端 SSH 监听服务错误'));
        this.logger.info({ event: 'client_ssh_start', host: addr.address, port: addr.port, hostKeyFingerprint: fingerprint }, '客户端 SSH 服务端已启动');
        resolve({ host: addr.address, port: addr.port, hostKeyFingerprint: fingerprint });
      });
    });
  }

  injectWebSocket(ws: WebSocket, remoteIp?: string): void {
    const closeWs = (code?: number, reason?: string) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    };
    const terminateWs = () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    };
    if (!this.sshServer || this.stopping) return closeWs(1011, '服务未就绪');
    const duplex = createWebSocketStream(ws);
    ws.once('close', () => { if (!duplex.destroyed) duplex.destroy(); });
    ws.on('error', () => { if (!duplex.destroyed) duplex.destroy(); });
    duplex.once('end', () => closeWs());
    duplex.once('close', terminateWs);
    duplex.on('error', terminateWs);
    if (!this.acceptRawSocket(duplex, remoteIp)) closeWs(1013, '客户端连接数已达上限');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.options.registry.closeAll('client_ssh_server_stopping');
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer);
    this.handshakeTimers.clear();
    for (const client of [...this.activeClients]) { try { client.end(); } catch { /* ignore */ } }
    this.activeClients.clear();
    for (const socket of [...this.rawSockets]) { try { socket.destroy(); } catch { /* ignore */ } }
    this.rawSockets.clear();
    this.preAuthSockets.clear();
    this.connectionsPerIp.clear();
    const tcpServer = this.tcpServer;
    this.tcpServer = undefined;
    this.sshServer = undefined;
    this.boundPort = undefined;
    if (!tcpServer) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      tcpServer.close(() => { clearTimeout(timer); resolve(); });
    });
  }

  private acceptRawSocket(socket: Duplex, remoteIp?: string): boolean {
    // Attach before any early-rejection destroy() so a closing peer cannot emit an unhandled socket error.
    socket.on('error', () => undefined);
    if (this.stopping || !this.sshServer) {
      if (!socket.destroyed) socket.destroy();
      return false;
    }
    if (this.rawSockets.size >= this.maxConnections) {
      this.logger.warn({ maxConnections: this.maxConnections }, '客户端 SSH 连接数达到上限，已拒绝新连接');
      if (!socket.destroyed) socket.destroy();
      return false;
    }
    if (this.preAuthSockets.size >= this.maxPreAuthConnections) {
      this.logger.warn({ maxPreAuthConnections: this.maxPreAuthConnections }, '客户端 SSH 未认证并发连接数达到上限，已拒绝新连接');
      if (!socket.destroyed) socket.destroy();
      return false;
    }
    const ip = normalizeRemoteIp(remoteIp);
    // Reverse-proxied WS tunnels arrive from loopback (127.0.0.1 / ::1); only apply per-IP caps to non-loopback peers.
    const trackedIp = ip && !isLoopbackIp(ip) ? ip : undefined;
    if (trackedIp) {
      const currentForIp = this.connectionsPerIp.get(trackedIp) ?? 0;
      if (currentForIp >= this.maxConnectionsPerIp) {
        this.logger.warn({ ip: trackedIp, maxConnectionsPerIp: this.maxConnectionsPerIp }, '单来源 IP 客户端 SSH 并发连接数达到上限，已拒绝新连接');
        if (!socket.destroyed) socket.destroy();
        return false;
      }
      this.connectionsPerIp.set(trackedIp, currentForIp + 1);
    }
    this.rawSockets.add(socket);
    this.preAuthSockets.add(socket);
    const timer = setTimeout(() => {
      this.handshakeTimers.delete(socket);
      this.logger.warn({ timeoutMs: this.handshakeTimeoutMs }, '客户端 SSH 握手/认证超时，已断开');
      if (!socket.destroyed) socket.destroy();
    }, this.handshakeTimeoutMs);
    timer.unref();
    this.handshakeTimers.set(socket, timer);
    socket.once('close', () => {
      this.clearHandshakeTimer(socket);
      this.rawSockets.delete(socket);
      this.preAuthSockets.delete(socket);
      if (trackedIp) {
        const remaining = (this.connectionsPerIp.get(trackedIp) ?? 1) - 1;
        if (remaining > 0) this.connectionsPerIp.set(trackedIp, remaining);
        else this.connectionsPerIp.delete(trackedIp);
      }
    });
    this.sshServer.injectSocket(socket as unknown as Socket);
    return true;
  }

  private clearHandshakeTimer(socket: Duplex | undefined): void {
    if (!socket) return;
    const timer = this.handshakeTimers.get(socket);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimers.delete(socket);
    }
  }

  private async loadOrCreateHostKey(): Promise<{ hostKeyPem: string; fingerprint: string }> {
    const dir = join(this.options.dataDir, 'client-ssh');
    const encryptedPath = join(dir, 'host_ed25519.enc');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    let hostKeyPem: string | undefined;
    try { hostKeyPem = this.options.keyStore.decrypt(await readFile(encryptedPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!hostKeyPem) {
      hostKeyPem = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'clinavat-client-host' }).private;
      await atomicWrite(encryptedPath, this.options.keyStore.encrypt(hostKeyPem), 0o600);
    }
    const parsed = ssh2.utils.parseKey(hostKeyPem);
    if (parsed instanceof Error || !parsed.isPrivateKey() || parsed.type !== 'ssh-ed25519') {
      throw new Error('客户端 SSH 服务端 Ed25519 主机密钥无效');
    }
    return { hostKeyPem, fingerprint: sshPublicKeyFingerprint(parsed) };
  }

  private lookupActiveDevice(deviceId: string): AuthenticatedDeviceRow | undefined {
    return this.options.store.get<AuthenticatedDeviceRow>(
      `SELECT d.id AS device_id, d.dev_host_id AS host_id, d.user_id, d.public_key,
              d.platform, d.arch, d.os_version, d.default_shell, d.homedir
       FROM client_devices d
       JOIN dev_hosts h ON h.id = d.dev_host_id AND h.user_id = d.user_id AND h.kind = 'client'
       JOIN users u ON u.id = d.user_id AND u.suspended_at IS NULL
       WHERE d.id = ?`,
      deviceId,
    );
  }

  private handleClient(client: SshServerConnection): void {
    this.activeClients.add(client);
    const rawSock = (client as SshConnectionWithSocket)._sock;
    let authedDevice: AuthenticatedDeviceRow | undefined;
    let authedPublicKey: Buffer | undefined;
    let untrackPending: (() => void) | undefined;
    let activeConnectionId: string | undefined;
    let activeMux: Multiplexer | undefined;
    let sessionOpened = false;

    const endClient = () => {
      try { client.end(); } catch { /* ignore */ }
      if (rawSock && !rawSock.destroyed) { try { rawSock.destroy(); } catch { /* ignore */ } }
    };

    const cleanupConnection = (reason: string) => {
      this.activeClients.delete(client);
      this.clearHandshakeTimer(rawSock);
      untrackPending?.();
      untrackPending = undefined;
      if (activeMux) { activeMux.close(reason); activeMux = undefined; }
      if (authedDevice && activeConnectionId) {
        this.options.registry.unregisterSession(authedDevice.host_id, activeConnectionId, reason);
      }
    };

    client.on('error', error => {
      this.logger.warn({ err: error, deviceId: authedDevice?.device_id }, '客户端 SSH 连接错误');
      cleanupConnection('ssh_error');
    });
    client.once('close', () => cleanupConnection('ssh_closed'));

    client.on('authentication', ctx => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const match = DEVICE_USERNAME_PATTERN.exec(ctx.username);
      if (!match) return ctx.reject(['publickey']);
      const row = this.lookupActiveDevice(match[1]!);
      if (!row) return ctx.reject(['publickey']);
      const parsed = ssh2.utils.parseKey(row.public_key);
      if (parsed instanceof Error || parsed.type !== 'ssh-ed25519' || ctx.key.algo !== parsed.type) {
        return ctx.reject(['publickey']);
      }
      const expectedKey = parsed.getPublicSSH();
      if (ctx.key.data.length !== expectedKey.length || !timingSafeEqual(ctx.key.data, expectedKey)) {
        return ctx.reject(['publickey']);
      }
      if (!ctx.signature) return ctx.accept();
      if (!ctx.blob || parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
      authedDevice = row;
      authedPublicKey = Buffer.from(expectedKey);
      untrackPending?.();
      untrackPending = this.options.registry.trackPendingConnection({
        hostId: row.host_id, userId: row.user_id, deviceId: row.device_id, disconnect: endClient,
      });
      ctx.accept();
    });

    client.on('ready', () => {
      this.clearHandshakeTimer(rawSock);
      if (rawSock) this.preAuthSockets.delete(rawSock);
      client.on('tcpip', (_accept, reject) => reject());
      client.on('openssh.streamlocal', (_accept, reject) => reject());
      client.on('request', (_accept, reject) => reject?.());

      client.on('session', (accept, reject) => {
        if (!authedDevice || !authedPublicKey || sessionOpened || activeMux) return reject();
        sessionOpened = true;
        const session = accept();
        const rejectAndClose = (r?: () => void) => { r?.(); try { session.close(); } catch { /* ignore */ } endClient(); };
        session.on('pty', (_a, r) => r?.());
        session.on('shell', (_a, r) => rejectAndClose(r));
        session.on('sftp', (_a, r) => rejectAndClose(r));
        session.on('subsystem', (_a, r) => rejectAndClose(r));
        for (const evt of ['x11', 'auth-agent', 'env', 'window-change', 'signal'] as const) {
          session.on(evt, (_a: unknown, r?: () => void) => r?.());
        }

        session.on('exec', (acceptExec, rejectExec, info) => {
          if (!authedDevice || !authedPublicKey || activeMux || info.command !== AGENT_EXEC_COMMAND) {
            return rejectAndClose(rejectExec);
          }
          // Re-verify active user and key equality so a key rotation or revoke after auth cannot open a session.
          const currentRow = this.lookupActiveDevice(authedDevice.device_id);
          const currentKey = currentRow ? parseEd25519PublicBytes(currentRow.public_key) : null;
          if (!currentRow || !currentKey || currentKey.length !== authedPublicKey.length
            || !timingSafeEqual(currentKey, authedPublicKey)) {
            return rejectAndClose(rejectExec);
          }
          const channel = acceptExec();
          const connectionId = randomUUID();
          const mux = new Multiplexer(channel);
          activeConnectionId = connectionId;
          activeMux = mux;
          untrackPending?.();
          untrackPending = undefined;

          const onChannelDone = (reason: string) => {
            mux.close(reason);
            this.options.registry.unregisterSession(currentRow.host_id, connectionId, reason);
            try { client.end(); } catch { /* ignore */ }
          };
          channel.once('close', () => onChannelDone('channel_closed'));
          channel.on('error', () => onChannelDone('channel_error'));

          this.options.registry.registerSession({
            connectionId, hostId: currentRow.host_id, deviceId: currentRow.device_id, userId: currentRow.user_id,
            platform: currentRow.platform, arch: currentRow.arch, osVersion: currentRow.os_version,
            defaultShell: currentRow.default_shell, homedir: currentRow.homedir, mux,
            disconnect: () => { try { channel.close(); } catch { /* ignore */ } endClient(); },
          });
        });
      });
    });
  }
}
