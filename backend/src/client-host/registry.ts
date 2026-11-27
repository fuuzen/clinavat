import type { Store } from '../database.js';
import type { EventBus } from '../events.js';
import type { ClientDevice } from '../models.js';
import {
  ClientDisconnectedError,
  type Multiplexer,
  type MuxStream,
  type RpcCallOptions,
  type RpcRequestContext,
} from './protocol.js';

export interface ActiveClientSession {
  readonly connectionId: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly platform: string;
  readonly arch: string;
  readonly osVersion: string;
  readonly defaultShell: string;
  readonly homedir: string;
  readonly connectedAt: string;
  lastSeenAt: string;
  readonly mux: Multiplexer;
  readonly disconnect: (reason?: string) => void;
}

export interface RegisterClientSessionInput {
  connectionId: string;
  hostId: string;
  deviceId: string;
  userId: string;
  platform: string;
  arch: string;
  osVersion: string;
  defaultShell: string;
  homedir: string;
  mux: Multiplexer;
  disconnect: (reason?: string) => void;
}

export interface ClientDeviceStatus {
  hostId: string;
  online: boolean;
  deviceId?: string;
  connectionId?: string;
  connectedAt?: string;
  lastSeenAt: string | null;
  platform?: string;
  arch?: string;
  osVersion?: string;
  defaultShell?: string;
  homedir?: string;
}

export type ClientDisconnectListener = (info: {
  hostId: string;
  deviceId: string;
  connectionId: string;
  reason?: string;
}) => void;

export type ClientRpcHandler = (
  session: ActiveClientSession,
  params: unknown,
  context: RpcRequestContext,
) => unknown | Promise<unknown>;

export interface PendingClientConnection {
  hostId: string;
  userId: string;
  deviceId: string;
  disconnect: (reason?: string) => void;
}

export class ClientHostRegistry {
  private readonly sessions = new Map<string, ActiveClientSession>();
  private readonly pendingConnections = new Set<PendingClientConnection>();
  private readonly disconnectListeners = new Map<string, Set<ClientDisconnectListener>>();
  private readonly rpcHandlers = new Map<string, ClientRpcHandler>();

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
  ) {
    this.registerRpcHandler('heartbeat', session => {
      const now = new Date().toISOString();
      session.lastSeenAt = now;
      this.safeUpdateLastSeen(session.deviceId, now);
      return { ok: true, serverTime: now };
    });
  }

  registerRpcHandler(method: string, handler: ClientRpcHandler): () => void {
    this.rpcHandlers.set(method, handler);
    for (const session of this.sessions.values()) {
      session.mux.registerHandler(method, (params, context) => handler(session, params, context));
    }
    return () => {
      if (this.rpcHandlers.get(method) === handler) this.rpcHandlers.delete(method);
    };
  }

  registerSession(input: RegisterClientSessionInput): ActiveClientSession {
    const now = new Date().toISOString();
    const session: ActiveClientSession = {
      ...input,
      connectedAt: now,
      lastSeenAt: now,
    };
    const previous = this.sessions.get(input.hostId);
    // Store the new generation before tearing down the previous connection so stale close events are ignored.
    this.sessions.set(input.hostId, session);

    for (const [method, handler] of this.rpcHandlers) {
      session.mux.registerHandler(method, (params, context) => handler(session, params, context));
    }
    session.mux.onClose(() => {
      this.unregisterSession(input.hostId, input.connectionId, 'transport_closed');
    });

    if (previous && previous.connectionId !== input.connectionId) {
      try { previous.mux.close('replaced_by_new_connection'); } catch { /* ignore */ }
      try { previous.disconnect('replaced_by_new_connection'); } catch { /* ignore */ }
    }

    this.updateHostStatus(input.hostId, input.deviceId, 'CONNECTED', now);
    this.events.broadcast(input.userId, {
      type: 'host',
      payload: {
        id: input.hostId,
        kind: 'client',
        status: 'CONNECTED',
        deviceId: input.deviceId,
        last_seen_at: now,
      },
    });
    return session;
  }

  unregisterSession(hostId: string, connectionId: string, reason?: string): boolean {
    const current = this.sessions.get(hostId);
    if (!current || current.connectionId !== connectionId) return false;
    this.sessions.delete(hostId);

    const now = new Date().toISOString();
    current.lastSeenAt = now;
    this.updateHostStatus(hostId, current.deviceId, 'DISCONNECTED', now);
    this.events.broadcast(current.userId, {
      type: 'host',
      payload: {
        id: hostId,
        kind: 'client',
        status: 'DISCONNECTED',
        deviceId: current.deviceId,
        last_seen_at: now,
      },
    });

    const listeners = this.disconnectListeners.get(hostId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener({ hostId, deviceId: current.deviceId, connectionId, reason });
        } catch { /* isolate disconnect listeners */ }
      }
    }
    return true;
  }

  isOnline(hostId: string): boolean {
    const session = this.sessions.get(hostId);
    return !!session && !session.mux.isClosed;
  }

  getSession(hostId: string): ActiveClientSession | undefined {
    const session = this.sessions.get(hostId);
    return session && !session.mux.isClosed ? session : undefined;
  }

  getDeviceStatus(hostId: string): ClientDeviceStatus {
    const active = this.getSession(hostId);
    if (active) {
      return {
        hostId,
        online: true,
        deviceId: active.deviceId,
        connectionId: active.connectionId,
        connectedAt: active.connectedAt,
        lastSeenAt: active.lastSeenAt,
        platform: active.platform,
        arch: active.arch,
        osVersion: active.osVersion,
        defaultShell: active.defaultShell,
        homedir: active.homedir,
      };
    }
    const device = this.store.get<ClientDevice>('SELECT * FROM client_devices WHERE dev_host_id=?', hostId);
    return {
      hostId,
      online: false,
      deviceId: device?.id,
      lastSeenAt: device?.last_seen_at ?? null,
      platform: device?.platform,
      arch: device?.arch,
      osVersion: device?.os_version,
      defaultShell: device?.default_shell,
      homedir: device?.homedir,
    };
  }

  callRpc<T = unknown>(hostId: string, method: string, params?: unknown, options?: RpcCallOptions): Promise<T> {
    const session = this.getSession(hostId);
    if (!session) return Promise.reject(new ClientDisconnectedError('客户端设备当前不在线'));
    return session.mux.callRpc<T>(method, params, options);
  }

  openStream(hostId: string, method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<MuxStream> {
    const session = this.getSession(hostId);
    if (!session) return Promise.reject(new ClientDisconnectedError('客户端设备当前不在线'));
    return session.mux.openStream(method, params, signal);
  }

  trackPendingConnection(connection: PendingClientConnection): () => void {
    this.pendingConnections.add(connection);
    return () => { this.pendingConnections.delete(connection); };
  }

  disconnectHost(hostId: string, reason = 'disconnected'): boolean {
    let disconnected = false;
    for (const pending of [...this.pendingConnections]) {
      if (pending.hostId !== hostId) continue;
      this.pendingConnections.delete(pending);
      try { pending.disconnect(reason); } catch { /* ignore */ }
      disconnected = true;
    }
    const session = this.sessions.get(hostId);
    if (!session) return disconnected;
    this.unregisterSession(hostId, session.connectionId, reason);
    try { session.mux.close(reason); } catch { /* ignore */ }
    try { session.disconnect(reason); } catch { /* ignore */ }
    return true;
  }

  disconnectUser(userId: string, reason = 'user_disconnected'): number {
    let count = 0;
    for (const pending of [...this.pendingConnections]) {
      if (pending.userId !== userId) continue;
      this.pendingConnections.delete(pending);
      try { pending.disconnect(reason); } catch { /* ignore */ }
      count += 1;
    }
    const hostIds = [...this.sessions.values()]
      .filter(session => session.userId === userId)
      .map(session => session.hostId);
    for (const hostId of hostIds) {
      if (this.disconnectHost(hostId, reason)) count += 1;
    }
    return count;
  }

  closeAll(reason = 'server_closing'): void {
    for (const pending of [...this.pendingConnections]) {
      this.pendingConnections.delete(pending);
      try { pending.disconnect(reason); } catch { /* ignore */ }
    }
    for (const hostId of [...this.sessions.keys()]) {
      this.disconnectHost(hostId, reason);
    }
  }

  onDisconnect(hostId: string, listener: ClientDisconnectListener): () => void {
    let listeners = this.disconnectListeners.get(hostId);
    if (!listeners) {
      listeners = new Set();
      this.disconnectListeners.set(hostId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.disconnectListeners.get(hostId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.disconnectListeners.delete(hostId);
    };
  }

  private updateHostStatus(hostId: string, deviceId: string, status: 'CONNECTED' | 'DISCONNECTED', timestamp: string): void {
    try {
      this.store.run("UPDATE dev_hosts SET status=? WHERE id=? AND kind='client'", status, hostId);
      this.store.run('UPDATE client_devices SET last_seen_at=? WHERE id=?', timestamp, deviceId);
    } catch { /* database may already be closing during shutdown */ }
  }

  private safeUpdateLastSeen(deviceId: string, timestamp: string): void {
    try {
      this.store.run('UPDATE client_devices SET last_seen_at=? WHERE id=?', timestamp, deviceId);
    } catch { /* ignore during shutdown */ }
  }
}
