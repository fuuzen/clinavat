import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join, posix } from 'node:path';
import type { Store } from '../database.js';
import type { ClientDevice, Host, Project } from '../models.js';
import type { SkippedLinks } from '../runtime/sync-status.js';
import type { RuntimeConfig } from '../runtime/types.js';
import type { ClientMirrorSync } from './mirror-sync.js';
import { assertClientPath, rewriteCommandPaths, vmToClientPath } from './path-utils.js';
import type { ClientWorkspaceAdapter } from './workspace-adapter.js';

export interface ClientExecBarrierRequest {
  projectId: string;
  command: string;
  cwd: string;
  background?: boolean;
}

export interface ClientExecBarrierReply {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  notice?: string;
  error?: string;
}

const LOCK_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 600_000;
const MAX_LINE_BYTES = 1024 * 1024;

function stripPosixTrailing(value: string): string {
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** Verifies `rawCwd` lies strictly inside `vmRoot` or `localRoot`, then maps it to the client host's path. */
function resolveContainedClientCwd(
  platform: string, vmRoot: string, localRoot: string, clientRoot: string, rawCwd: string,
): string {
  if (!rawCwd) return assertClientPath(platform, clientRoot);
  if (/[\0\r\n]/.test(rawCwd) || !posix.isAbsolute(rawCwd) || rawCwd.split('/').includes('..')) {
    throw new Error('工作目录路径无效或包含非法回溯');
  }
  const cleanCwd = stripPosixTrailing(rawCwd);
  const cleanVmRoot = stripPosixTrailing(vmRoot);
  const cleanLocalRoot = stripPosixTrailing(localRoot);
  if (cleanCwd === cleanVmRoot || cleanCwd.startsWith(`${cleanVmRoot}/`)) {
    return vmToClientPath(platform, cleanVmRoot, clientRoot, cleanCwd);
  }
  if (cleanCwd === cleanLocalRoot || cleanCwd.startsWith(`${cleanLocalRoot}/`)) {
    return vmToClientPath(platform, cleanLocalRoot, clientRoot, cleanCwd);
  }
  throw new Error('工作目录超出项目根目录范围');
}

class BarrierProjectLocks {
  private readonly tails = new Map<string, Promise<void>>();

  acquire(key: string, timeoutMs: number): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error('another project command is still running; lock acquisition timed out'));
      }, timeoutMs);
      void previous.then(() => {
        clearTimeout(timer);
        if (expired) { release(); return; }
        let released = false;
        resolve(() => { if (!released) { released = true; release(); } });
      });
    });
  }
}

/**
 * Executes Mode 2 (`mirrored`) client commands with pre/post sync barriers.
 * Used directly by LXD `SyncBarriers` (via VM relay) and over a mode-0600 Unix socket in `process` mode.
 */
export class ClientExecBarrier {
  readonly socketPath: string;
  private readonly masterSecret: Buffer;
  private readonly locks = new BarrierProjectLocks();
  private server?: Server;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: Store,
    private readonly mirrorSync: ClientMirrorSync,
    private readonly adapter: ClientWorkspaceAdapter,
    private readonly reportSkippedLinks?: (userId: string, syncName: string, skipped: SkippedLinks) => string | undefined,
  ) {
    this.socketPath = join(config.dataDir, 'run', 'client-exec.sock');
    this.masterSecret = randomBytes(32);
  }

  /** Derives a project-scoped HMAC-SHA256 barrier token so one project's script cannot invoke another project. */
  tokenForProject(projectId: string): string {
    return createHmac('sha256', this.masterSecret).update(projectId).digest('hex');
  }

  async start(): Promise<void> {
    if (this.server) return;
    const runDir = join(this.config.dataDir, 'run');
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    const server = createServer(socket => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        server.on('error', () => undefined);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  async execute(userId: string | undefined, request: ClientExecBarrierRequest): Promise<ClientExecBarrierReply> {
    try {
      const project = this.store.get<Project>('SELECT * FROM projects WHERE id=?', request.projectId);
      if (!project) return { ok: false, error: '项目不存在' };
      if (userId !== undefined && project.user_id !== userId) {
        return { ok: false, error: '项目不属于当前用户' };
      }
      const host = this.store.get<Host>('SELECT * FROM dev_hosts WHERE id=?', project.dev_host_id);
      if (!host || host.kind !== 'client' || project.client_mode !== 'mirrored') {
        return { ok: false, error: '仅客户端镜像模式项目支持此执行屏障' };
      }
      const device = this.store.get<ClientDevice>('SELECT * FROM client_devices WHERE dev_host_id=?', host.id);
      const platform = device?.platform ?? 'linux';
      const vmRoot = project.vm_path || project.local_path;
      const clientCwd = resolveContainedClientCwd(platform, vmRoot, project.local_path, project.remote_path, request.cwd);
      const mappedCommand = rewriteCommandPaths(platform, [vmRoot, project.local_path], project.remote_path, request.command);

      if (request.background) {
        const release = await this.locks.acquire(project.sync_name, LOCK_TIMEOUT_MS);
        try { await this.mirrorSync.flush(project); }
        finally { release(); }
        const result = await this.adapter.execCommand(host.id, {
          cwd: clientCwd, command: mappedCommand, background: true,
        }, EXEC_TIMEOUT_MS);
        return { ok: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }

      const release = await this.locks.acquire(project.sync_name, LOCK_TIMEOUT_MS);
      try {
        await this.mirrorSync.flush(project);
        const result = await this.adapter.execCommand(host.id, {
          cwd: clientCwd, command: mappedCommand, background: false,
        }, EXEC_TIMEOUT_MS);
        await this.mirrorSync.flush(project);
        const health = this.mirrorSync.status(project);
        const notice = this.reportSkippedLinks?.(project.user_id, project.sync_name, health.skipped);
        return {
          ok: true,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(notice ? { notice } : {}),
        };
      } finally {
        release();
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private verifyProjectToken(projectId: string, candidate: unknown): boolean {
    if (!projectId || typeof candidate !== 'string') return false;
    const expected = Buffer.from(this.tokenForProject(projectId), 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private handleSocket(socket: Socket): void {
    let buffer = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        socket.end(JSON.stringify({ ok: false, error: '请求过大' }) + '\n');
        handled = true;
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      const line = buffer.slice(0, nl);
      void (async () => {
        try {
          const parsed = JSON.parse(line) as Partial<ClientExecBarrierRequest> & { op?: string; token?: unknown };
          if (parsed.op !== 'client_exec' || typeof parsed.projectId !== 'string'
            || !this.verifyProjectToken(parsed.projectId, parsed.token) || typeof parsed.command !== 'string') {
            socket.end(JSON.stringify({ ok: false, error: '无效的执行屏障请求' }) + '\n');
            return;
          }
          const reply = await this.execute(undefined, {
            projectId: parsed.projectId,
            command: parsed.command,
            cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
            background: parsed.background === true,
          });
          if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
        } catch (error) {
          if (!socket.destroyed) {
            socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '请求解析失败' }) + '\n');
          }
        }
      })();
    });
  }
}
