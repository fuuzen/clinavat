import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { Client, type ClientChannel } from 'ssh2';
import type { WebSocket } from 'ws';
import type { DevHostApprovalStore } from './dev-host-approvals.js';
import { attachLocalTerminal } from './local-terminal.js';
import { remoteCommand } from './remote-paths.js';
import { SshManager } from './ssh.js';
import { dialAuthorizedTcp, type SshTargetPolicy } from './target-policy.js';
import { assertHostOwner, assertSshHost, type DevHost, type WorkspaceProject } from './types.js';
import { WorkspaceManager } from './workspace.js';

export interface TerminalRevokeFilter {
  userId?: string;
  devHostId?: string;
  pinnedIp?: string;
  port?: number;
}

export interface TerminalSecurityOptions {
  policy: SshTargetPolicy;
  approvals: DevHostApprovalStore;
  requirePrivateApproval: boolean;
  isUserActive?: (userId: string) => boolean;
}

const privateApprovalRequiredMessage =
  '该内网开发机尚未获得管理员审批，请联系管理员在「网关 / 内网开发机审批」面板批准后再打开终端';
const userUnavailableMessage = '用户账号已停用或不存在，无法打开终端';

interface ActiveTerminalSocket {
  id: string;
  userId: string;
  devHostId: string;
  pinnedIp: string;
  port: number;
  rawSocket: Socket;
  revoke: (reason?: string) => void;
}

const activeTerminals = new Map<string, ActiveTerminalSocket>();

/** Disconnects matching active Web terminal TCP sockets immediately. */
export function revokeSockets(filter: TerminalRevokeFilter, reason = '开发机连接授权已变更，终端已断开'): number {
  const matched: ActiveTerminalSocket[] = [];
  for (const entry of activeTerminals.values()) {
    if (filter.userId !== undefined && entry.userId !== filter.userId) continue;
    if (filter.devHostId !== undefined && entry.devHostId !== filter.devHostId) continue;
    if (filter.pinnedIp !== undefined && entry.pinnedIp !== filter.pinnedIp) continue;
    if (filter.port !== undefined && entry.port !== filter.port) continue;
    matched.push(entry);
  }
  for (const entry of matched) {
    activeTerminals.delete(entry.id);
    entry.revoke(reason);
  }
  return matched.length;
}

export async function attachTerminal(
  socket: WebSocket, userId: string, host: DevHost, project: WorkspaceProject,
  ssh: SshManager, workspaces: WorkspaceManager, security: TerminalSecurityOptions,
): Promise<void> {
  assertHostOwner(userId, host);
  if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
  if (host.kind === 'client') throw new Error('客户端开发机连接通道尚未启用');
  if (host.kind === 'local' || project.execution_mode === 'local') {
    if (host.kind !== 'local' || project.execution_mode !== 'local') throw new Error('本机项目与开发机类型不匹配');
    await attachLocalTerminal(socket, project, workspaces);
    return;
  }
  assertSshHost(host);

  const client = new Client();
  const jumpHost = ssh.jumpHost(host);
  const jumpClient = jumpHost ? new Client() : undefined;
  const terminalId = randomUUID();
  let rawSocket: Socket | undefined;
  let tunnel: ClientChannel | undefined;
  let channel: ClientChannel | undefined;
  let closed = false;
  let bytes = 0;
  let intervalStarted = Date.now();
  const send = (value: unknown) => {
    if (socket.readyState === 1) {
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.close(1013, '终端输出过快，请重新连接');
        return;
      }
      socket.send(JSON.stringify(value));
    }
  };
  const shutdown = () => {
    if (closed) return;
    closed = true;
    activeTerminals.delete(terminalId);
    channel?.close();
    client.end();
    tunnel?.destroy();
    jumpClient?.end();
    if (rawSocket && !rawSocket.destroyed) rawSocket.destroy();
  };
  socket.once('close', shutdown);
  socket.once('error', shutdown);
  socket.on('message', raw => {
    if (closed) return;
    const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    if (Date.now() - intervalStarted > 1000) { bytes = 0; intervalStarted = Date.now(); }
    bytes += data.length;
    if (bytes > 256 * 1024) { socket.close(1009, '终端输入过大'); return; }
    try {
      const message = JSON.parse(data.toString()) as { type?: string; data?: string; rows?: number; cols?: number };
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 64 * 1024) {
        channel?.write(message.data);
      } else if (message.type === 'resize' && Number.isInteger(message.rows) && Number.isInteger(message.cols)) {
        const rows = Math.max(1, Math.min(message.rows!, 500));
        const cols = Math.max(1, Math.min(message.cols!, 500));
        channel?.setWindow(rows, cols, 0, 0);
      }
    } catch { send({ type: 'error', message: '终端消息格式无效' }); }
  });

  try {
    const firstHop = jumpHost ?? host;
    const classified = await security.policy.classifyTarget(firstHop.host, firstHop.port);
    const assertStillAuthorized = () => {
      if (security.isUserActive && !security.isUserActive(userId)) {
        throw new Error(userUnavailableMessage);
      }
      if (security.requirePrivateApproval && classified.kind === 'private'
        && !security.approvals.findApproved(userId, classified.pinnedIp, classified.port)) {
        throw new Error(privateApprovalRequiredMessage);
      }
    };
    assertStillAuthorized();

    await workspaces.flush(project);
    const [privateKey, hostKeys, jumpPrivateKey, jumpHostKeys] = await Promise.all([
      ssh.terminalIdentity(userId, host), ssh.knownHostKeys(userId, host),
      jumpHost ? ssh.terminalIdentity(userId, jumpHost) : undefined,
      jumpHost ? ssh.knownHostKeys(userId, jumpHost) : [],
    ]);
    if (!hostKeys.length) throw new Error('请先验证开发机 SSH 连接和主机密钥');
    if (jumpHost && !jumpHostKeys.length) throw new Error('请先验证跳板机 SSH 连接和主机密钥');
    if (closed) return;

    await security.policy.assertNotDenied(classified.pinnedIp);
    assertStillAuthorized();

    const dialed = await dialAuthorizedTcp(classified.pinnedIp, classified.port, 15_000);
    rawSocket = dialed;
    if (closed) { dialed.destroy(); return; }
    // Re-check approval and user status synchronously after dial to close the TOCTOU window before registration.
    try {
      assertStillAuthorized();
    } catch (error) {
      dialed.destroy();
      throw error;
    }
    activeTerminals.set(terminalId, {
      id: terminalId,
      userId,
      devHostId: host.id,
      pinnedIp: classified.pinnedIp,
      port: classified.port,
      rawSocket: dialed,
      revoke: reason => {
        if (reason) send({ type: 'error', message: reason });
        if (socket.readyState === 1) socket.close(1008, '连接授权已撤销');
        shutdown();
      },
    });
    dialed.once('close', () => { activeTerminals.delete(terminalId); });

    client.on('error', error => {
      send({ type: 'error', message: error.message });
      socket.close(1011, 'SSH 连接错误');
      shutdown();
    });
    client.on('close', () => {
      if (!closed) socket.close(1000, 'SSH 已断开');
      shutdown();
    });
    client.on('ready', () => {
      if (closed) { client.end(); return; }
      client.exec(remoteCommand(project), {
        pty: { term: 'xterm-256color', cols: 100, rows: 30 },
      }, (error, stream) => {
        if (error) {
          send({ type: 'error', message: error.message });
          socket.close(1011, '无法启动远端终端');
          shutdown();
          return;
        }
        if (closed) { stream.close(); return; }
        channel = stream;
        send({ type: 'ready' });
        stream.setEncoding('utf8');
        stream.stderr.setEncoding('utf8');
        stream.on('data', (data: string) => send({ type: 'output', data }));
        stream.stderr.on('data', (data: string) => send({ type: 'output', data }));
        stream.on('error', (error: Error) => {
          send({ type: 'error', message: error.message });
          socket.close(1011, '终端通道错误');
          shutdown();
        });
        stream.on('close', (code: number | undefined) => {
          if (closed) return;
          void workspaces.flush(project).catch(error => send({ type: 'error', message: (error as Error).message })).finally(() => {
            send({ type: 'exit', code: code ?? 0 });
            socket.close(1000, '终端已结束');
            shutdown();
          });
        });
      });
    });

    const connectTarget = (sock: ClientChannel | Socket) => client.connect({
      sock, username: host.username, privateKey,
      readyTimeout: 15_000, keepaliveInterval: 30_000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => hostKeys.some(known => key.length === known.length && timingSafeEqual(key, known)),
    });
    if (jumpClient && jumpHost) {
      jumpClient.on('error', error => {
        send({ type: 'error', message: `跳板机连接失败：${error.message}` });
        socket.close(1011, '跳板机连接错误');
        shutdown();
      });
      jumpClient.on('close', () => {
        if (!closed) socket.close(1011, '跳板机已断开');
        shutdown();
      });
      jumpClient.on('ready', () => {
        if (closed) { jumpClient.end(); return; }
        jumpClient.forwardOut('127.0.0.1', 0, host.host, host.port, (error, stream) => {
          if (error) {
            send({ type: 'error', message: `跳板机无法转发到开发机：${error.message}` });
            socket.close(1011, '跳板机转发失败');
            shutdown();
            return;
          }
          if (closed) { stream.destroy(); return; }
          tunnel = stream;
          tunnel.on('error', (error: Error) => {
            send({ type: 'error', message: `跳板机转发中断：${error.message}` });
            socket.close(1011, '跳板机转发中断');
            shutdown();
          });
          connectTarget(tunnel);
        });
      });
      jumpClient.connect({
        sock: dialed, username: jumpHost.username, privateKey: jumpPrivateKey,
        readyTimeout: 15_000, keepaliveInterval: 30_000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => jumpHostKeys.some(known => key.length === known.length && timingSafeEqual(key, known)),
      });
    } else connectTarget(dialed);
  } catch (error) {
    send({ type: 'error', message: (error as Error).message });
    socket.close(1011, '无法连接开发机');
    shutdown();
  }
}
