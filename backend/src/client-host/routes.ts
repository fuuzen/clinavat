import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import ssh2, { type ParsedKey } from 'ssh2';
import { z } from 'zod';
import { hostFor, withResourceLocks, type Context } from '../context.js';
import { HttpError, type ClientDevice, type Host } from '../models.js';

export const WS_TUNNEL_PATH = '/api/client-devices/tunnel';
const BOOTSTRAP_WINDOW_MS = 300_000;
const REPLAY_CACHE_MAX_ENTRIES = 10_000;
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const deviceIdField = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, '设备 ID 仅允许字母、数字及 ._-');

const registerDeviceInput = z.object({
  deviceId: deviceIdField,
  publicKey: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(64),
  arch: z.string().trim().min(1).max(64),
  osVersion: z.string().trim().max(128).default(''),
  defaultShell: z.string().trim().max(256).default(''),
  homedir: z.string().trim().max(4096).default(''),
});

const bootstrapInput = z.object({
  deviceId: deviceIdField,
  timestamp: z.coerce.number().int().positive(),
  signature: z.string().trim().min(1).max(512),
});

const hostIdParams = z.object({ hostId: z.uuid() });

interface BootstrapDeviceRow {
  device_id: string;
  host_id: string;
  host_name: string;
  public_key: string;
  suspended_at: string | null;
}

class BoundedReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = REPLAY_CACHE_MAX_ENTRIES) {}

  has(key: string, now = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  record(key: string, ttlMs: number, now = Date.now()): void {
    this.sweep(now);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, now + ttlMs);
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
      else break;
    }
  }
}

export function parseEd25519PublicKey(raw: string): { parsed: ParsedKey; normalized: string } {
  const parsed = ssh2.utils.parseKey(raw.trim());
  if (parsed instanceof Error || parsed.isPrivateKey() || parsed.type !== 'ssh-ed25519') {
    throw new HttpError(400, '设备公钥必须是有效的 ssh-ed25519 公钥');
  }
  const normalized = `ssh-ed25519 ${parsed.getPublicSSH().toString('base64')}`;
  return { parsed, normalized };
}

function decodeBase64Signature(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  const standard = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.length % 4 === 0 ? standard : standard + '='.repeat(4 - (standard.length % 4));
  const buffer = Buffer.from(padded, 'base64');
  return buffer.length === 64 ? buffer : null;
}

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (isIP(host) !== 0) return true;
  const labels = host.split('.');
  return labels.length > 0 && labels.every(label => HOSTNAME_LABEL_PATTERN.test(label));
}

export function sanitizeHostHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || /[\s/\\@?#]/.test(trimmed)) return undefined;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end <= 1) return undefined;
    const rest = trimmed.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return undefined;
    const ipv6 = trimmed.slice(1, end);
    return isIP(ipv6) === 6 ? ipv6 : undefined;
  }
  const firstColon = trimmed.indexOf(':');
  const lastColon = trimmed.lastIndexOf(':');
  if (firstColon !== lastColon) {
    return isIP(trimmed) === 6 ? trimmed : undefined;
  }
  if (firstColon >= 0 && !/^\d{1,5}$/.test(trimmed.slice(firstColon + 1))) return undefined;
  const host = firstColon >= 0 ? trimmed.slice(0, firstColon) : trimmed;
  return isValidHostname(host) ? host : undefined;
}

function resolveSshHost(context: Context, request: FastifyRequest): string {
  const configured = sanitizeHostHeader(context.config.clientSshHost);
  if (configured) return configured;
  const fromHostname = sanitizeHostHeader(request.hostname);
  if (fromHostname) return fromHostname;
  const fromHeader = sanitizeHostHeader(typeof request.headers.host === 'string' ? request.headers.host : undefined);
  return fromHeader ?? '127.0.0.1';
}

export function clientDeviceRoutes(app: FastifyInstance, context: Context): void {
  const { store, clientHostRegistry, clientSsh } = context;
  const replayCache = new BoundedReplayCache();

  app.post('/api/client-devices/register', async request => {
    const input = registerDeviceInput.parse(request.body);
    const { normalized: normalizedPublicKey } = parseEd25519PublicKey(input.publicKey);
    const userId = request.user.id;

    return withResourceLocks(context, [`user-hosts:${userId}`, `client-device:${input.deviceId}`], () => {
      const existing = store.get<ClientDevice>('SELECT * FROM client_devices WHERE id=?', input.deviceId);
      if (existing && existing.user_id !== userId) {
        throw new HttpError(409, '该设备已绑定其他账号');
      }

      let hostId: string;
      let publicKeyChanged = false;
      const now = new Date().toISOString();

      if (existing) {
        hostId = existing.dev_host_id;
        publicKeyChanged = existing.public_key !== normalizedPublicKey;
        store.transaction(() => {
          store.run(
            "UPDATE dev_hosts SET name=?,host=?,port=0,username=? WHERE id=? AND user_id=? AND kind='client'",
            input.name, input.deviceId, `device:${input.deviceId}`, hostId, userId,
          );
          store.run(
            `UPDATE client_devices
             SET public_key=?,platform=?,arch=?,os_version=?,default_shell=?,homedir=?
             WHERE id=? AND user_id=?`,
            normalizedPublicKey, input.platform, input.arch, input.osVersion, input.defaultShell, input.homedir,
            input.deviceId, userId,
          );
        });
        if (publicKeyChanged) {
          clientHostRegistry.disconnectHost(hostId, 'public_key_changed');
        }
      } else {
        hostId = randomUUID();
        store.transaction(() => {
          store.run(
            `INSERT INTO dev_hosts(id,user_id,name,host,port,username,status,kind)
             VALUES(?,?,?,?,0,?,'DISCONNECTED','client')`,
            hostId, userId, input.name, input.deviceId, `device:${input.deviceId}`,
          );
          store.run(
            `INSERT INTO client_devices(id,dev_host_id,user_id,public_key,platform,arch,os_version,default_shell,homedir,last_seen_at,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,NULL,?)`,
            input.deviceId, hostId, userId, normalizedPublicKey, input.platform, input.arch,
            input.osVersion, input.defaultShell, input.homedir, now,
          );
        });
      }

      const host = store.get<Host>('SELECT * FROM dev_hosts WHERE id=?', hostId)!;
      const device = store.get<ClientDevice>('SELECT * FROM client_devices WHERE id=?', input.deviceId)!;
      return {
        host,
        device,
        sshHost: resolveSshHost(context, request),
        sshPort: clientSsh.getPort(),
        wsTunnelPath: WS_TUNNEL_PATH,
        hostKeyFingerprint: clientSsh.getHostKeyFingerprint(),
      };
    });
  });

  app.post('/api/client-devices/bootstrap', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = bootstrapInput.parse(request.body);
    const nowMs = Date.now();
    const timestampMs = input.timestamp >= 1e12 ? input.timestamp : input.timestamp * 1000;
    if (Math.abs(nowMs - timestampMs) > BOOTSTRAP_WINDOW_MS) {
      return reply.code(401).send({ registered: false, error: '时间戳超出允许窗口' });
    }

    const sigBytes = decodeBase64Signature(input.signature);
    if (!sigBytes) {
      return reply.code(401).send({ registered: false, error: '签名格式无效' });
    }

    const replayKey = createHash('sha256')
      .update(`${input.deviceId}:${input.timestamp}:`)
      .update(sigBytes)
      .digest('hex');
    if (replayCache.has(replayKey, nowMs)) {
      return reply.code(401).send({ registered: false, error: '签名已使用，请重新发起引导请求' });
    }

    const row = store.get<BootstrapDeviceRow>(
      `SELECT d.id AS device_id, d.dev_host_id AS host_id, h.name AS host_name, d.public_key, u.suspended_at
       FROM client_devices d
       JOIN dev_hosts h ON h.id = d.dev_host_id AND h.user_id = d.user_id AND h.kind = 'client'
       JOIN users u ON u.id = d.user_id
       WHERE d.id = ?`,
      input.deviceId,
    );
    if (!row) {
      return { registered: false };
    }

    const parsed = ssh2.utils.parseKey(row.public_key);
    if (parsed instanceof Error || parsed.type !== 'ssh-ed25519') {
      return { registered: false };
    }

    const canonical = Buffer.from(`clinavat-bootstrap:${input.deviceId}:${input.timestamp}`, 'utf8');
    let verified = false;
    try {
      verified = parsed.verify(canonical, sigBytes) === true;
    } catch {
      verified = false;
    }
    if (!verified) {
      return reply.code(401).send({ registered: false, error: '设备签名验证失败' });
    }

    const replayTtlMs = Math.max(BOOTSTRAP_WINDOW_MS, timestampMs + BOOTSTRAP_WINDOW_MS - nowMs);
    replayCache.record(replayKey, replayTtlMs, nowMs);

    if (row.suspended_at !== null) {
      return { registered: false, suspended: true };
    }

    return {
      registered: true,
      hostId: row.host_id,
      hostName: row.host_name,
      sshHost: resolveSshHost(context, request),
      sshPort: clientSsh.getPort(),
      wsTunnelPath: WS_TUNNEL_PATH,
      hostKeyFingerprint: clientSsh.getHostKeyFingerprint(),
    };
  });

  app.get(WS_TUNNEL_PATH, { websocket: true, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, (socket, request) => {
    clientSsh.injectWebSocket(socket, request.ip);
  });

  app.post('/api/client-devices/:hostId/disconnect', async request => {
    const { hostId } = hostIdParams.parse(request.params);
    const host = hostFor(context, hostId, request.user.id);
    if (host.kind !== 'client') throw new HttpError(400, '仅客户端设备支持主动断开连接');
    const disconnected = clientHostRegistry.disconnectHost(host.id, 'user_requested');
    return { ok: true, disconnected };
  });
}
