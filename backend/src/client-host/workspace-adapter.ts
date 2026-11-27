import { Readable } from 'node:stream';
import { HttpError } from '../models.js';
import { assertClientPath, isProtectedInternalSegment, normalizePlatform, normalizeRelativePath } from './path-utils.js';
import { ClientDisconnectedError, RpcError, type MuxStream } from './protocol.js';
import type { ClientHostRegistry } from './registry.js';

export interface ClientDirectoryEntry { name: string; path: string; type: 'directory' }
export interface ClientDirectoryListing { path: string; roots?: string[]; entries: ClientDirectoryEntry[] }
type RawDirectoryEntry = string | { name?: unknown; path?: unknown; type?: unknown };
interface RawDirectoryListing { path?: unknown; roots?: unknown; entries?: RawDirectoryEntry[] }
export interface ClientFileEntry { name: string; kind: 'file' | 'directory' | 'symlink'; size?: number; mtimeMs?: number }
export interface ClientStatResult { exists: boolean; kind?: 'file' | 'directory' | 'symlink'; size?: number; mtimeMs?: number; isSymlink?: boolean }
export interface ClientReadResult { contentBase64: string; size: number; mtimeMs: number; isBinary?: boolean }
export interface ClientWriteParams {
  root: string; path: string; contentBase64: string; offset?: number; totalSize?: number;
  condition?: { createOnly?: boolean; expectedTag?: string }; createDirs?: boolean; commit?: boolean;
}
export interface ClientWriteResult { size: number; mtimeMs: number; received?: number }
export interface GitSnapshot { branch: string; status: string; diff: string }
export interface ClientExecParams {
  cwd: string; command: string; shell?: string; env?: Record<string, string>;
  background?: boolean; waitMs?: number; taskId?: string; sessionId?: string;
}
export interface ClientEditResult { replacements: number; size?: number; mtimeMs?: number; diff?: string }
export interface ClientApplyPatchResult { ok?: boolean; files: string[]; diff: string; hunks?: number; error?: string }
export interface ClientGlobResult { matches: string[]; truncated?: boolean }
export interface ClientGrepResult { matches: Array<{ path: string; line: number; text: string }>; truncated?: boolean }
export interface ClientExecResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; backgroundTaskId?: string }
export interface ClientPtyHandle { ptyId: string; stream: MuxStream }
export interface ClientRawFileHandle {
  handle: { createReadStream(range?: { start: number; end: number }): Readable; close(): Promise<void> };
  actualPath: string; size: number; mtime: number;
}

export type ClientWorktreeRequest =
  | { op: 'inspect'; root: string; directory?: string }
  | { op: 'create'; repo: string; root: string; head: string; branch: string; target?: string; directory?: string; destination?: string; worktreeName?: string; mainProjectId?: string }
  | { op: 'commit'; worktreePath: string; base: string; message: string }
  | { op: 'merge'; repo: string; branch: string; mode: 'merge' | 'squash'; onConflict: 'abort' | 'leave'; message: string }
  | { op: 'remove'; repo: string; worktreePath: string; branch: string };

const MAX_INLINE_TEXT_BYTES = 1024 * 1024;
const STREAM_FALLBACK_CHUNK = 512 * 1024;

export function mapClientRpcError(error: unknown, fallbackStatus = 502): Error {
  if (error instanceof HttpError) return error;
  if (error instanceof ClientDisconnectedError) return new HttpError(503, error.message);
  if (error instanceof RpcError) {
    const code = error.code.toUpperCase();
    if (code === 'ENOENT' || code === 'NOT_FOUND') return new HttpError(404, error.message || '文件或目录不存在');
    if (code === 'EACCES' || code === 'EPERM' || code === 'PERMISSION_DENIED') return new HttpError(403, error.message || '没有访问权限');
    if (code === 'EEXIST' || code === 'PRECONDITION_FAILED') return new HttpError(412, error.message || '文件状态冲突');
    if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'CONFLICT') return new HttpError(409, error.message || '目标路径冲突');
    if (code === 'INVALID_ARGUMENT' || code === 'EINVAL') return new HttpError(400, error.message || '请求参数无效');
    if (code === 'RPC_TIMEOUT') return new HttpError(504, error.message);
    return new HttpError(fallbackStatus, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** High-level typed RPC adapter over `ClientHostRegistry` for client-hosted workspaces. */
export class ClientWorkspaceAdapter {
  constructor(private readonly registry: ClientHostRegistry) {}

  async listDirectories(hostId: string, path?: string): Promise<ClientDirectoryListing> {
    const session = this.registry.getSession(hostId);
    const params: { path?: string } = {};
    if (path) params.path = session ? assertClientPath(session.platform, path) : path;
    const result = await this.registry.callRpc<RawDirectoryListing>(hostId, 'fs.list_directories', params);
    const rawPath = typeof result?.path === 'string' ? result.path : (params.path ?? '');
    const platform = session ? normalizePlatform(session.platform) : (/^[A-Za-z]:[\\/]/.test(rawPath) ? 'windows' : 'linux');
    const basePath = rawPath ? assertClientPath(platform, rawPath) : '';
    const entries: ClientDirectoryEntry[] = [];
    for (const item of Array.isArray(result?.entries) ? result.entries : []) {
      const name = typeof item === 'string' ? item : (item && typeof item === 'object' && typeof item.name === 'string' ? item.name : '');
      if (!name || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)) continue;
      if (typeof item === 'object' && item !== null && item.type !== undefined && item.type !== 'directory') continue;
      const entryPath = !basePath
        ? (typeof item === 'object' && typeof item.path === 'string' ? assertClientPath(platform, item.path) : name)
        : platform === 'windows'
          ? (basePath.endsWith('\\') ? `${basePath}${name}` : `${basePath}\\${name}`)
          : (basePath === '/' ? `/${name}` : `${basePath}/${name}`);
      entries.push({ name, path: entryPath, type: 'directory' });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const roots = Array.isArray(result?.roots) ? result.roots.filter((r): r is string => typeof r === 'string') : undefined;
    return { path: basePath, ...(roots ? { roots } : {}), entries };
  }

  private relPathFor(hostId: string, relPath: string | undefined, allowEmpty = false): string {
    return normalizeRelativePath(relPath, { allowEmpty, platform: this.registry.getSession(hostId)?.platform });
  }

  async listFiles(hostId: string, root: string, relPath = ''): Promise<{
    path: string;
    entries: Array<{ name: string; path: string; type: 'directory' | 'file'; size?: number }>;
  }> {
    const cleanRel = this.relPathFor(hostId, relPath, true);
    const response = await this.registry.callRpc<{ path?: string; entries?: ClientFileEntry[] }>(
      hostId, 'fs.list', { root, ...(cleanRel ? { path: cleanRel } : {}) },
    );
    const rawEntries = Array.isArray(response?.entries) ? response.entries : [];
    const prefix = cleanRel.replace(/\/$/, '');
    const entries = rawEntries
      .filter(entry => entry.name && !isProtectedInternalSegment(entry.name) && entry.kind !== 'symlink')
      .map(entry => {
        const type = entry.kind === 'directory' ? 'directory' as const : 'file' as const;
        return {
          name: entry.name,
          path: [prefix, entry.name].filter(Boolean).join('/'),
          type,
          size: type === 'file' ? entry.size : undefined,
        };
      })
      .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1));
    return { path: cleanRel, entries };
  }

  async stat(hostId: string, root: string, relPath: string): Promise<ClientStatResult> {
    const cleanRel = this.relPathFor(hostId, relPath, true);
    return this.registry.callRpc<ClientStatResult>(hostId, 'fs.stat', { root, path: cleanRel });
  }

  async readSlice(hostId: string, root: string, relPath: string, offset = 0, maxBytes = MAX_INLINE_TEXT_BYTES): Promise<{
    buffer: Buffer; size: number; mtimeMs: number; isBinary: boolean;
  }> {
    const cleanRel = this.relPathFor(hostId, relPath);
    const result = await this.registry.callRpc<ClientReadResult>(hostId, 'fs.read', {
      root, path: cleanRel, offset, maxBytes,
    });
    const buffer = Buffer.from(result.contentBase64 || '', 'base64');
    return {
      buffer,
      size: result.size,
      mtimeMs: result.mtimeMs,
      isBinary: Boolean(result.isBinary) || buffer.includes(0),
    };
  }

  async readFile(hostId: string, root: string, relPath: string): Promise<{
    path: string; size: number; mtime: number; binary: boolean; content?: string;
  }> {
    const cleanRel = this.relPathFor(hostId, relPath);
    const meta = await this.stat(hostId, root, cleanRel);
    if (!meta.exists || meta.kind !== 'file' || meta.isSymlink) {
      throw new HttpError(404, '文件不存在或无法访问');
    }
    const size = meta.size ?? 0;
    const mtime = Math.floor(meta.mtimeMs ?? 0);
    if (size > MAX_INLINE_TEXT_BYTES) {
      return { path: cleanRel, size, mtime, binary: true };
    }
    const result = await this.readSlice(hostId, root, cleanRel, 0, MAX_INLINE_TEXT_BYTES);
    const finalMtime = Math.floor(result.mtimeMs || mtime);
    if (result.size > MAX_INLINE_TEXT_BYTES || result.isBinary) {
      return { path: cleanRel, size: result.size, mtime: finalMtime, binary: true };
    }
    return { path: cleanRel, size: result.size, mtime: finalMtime, binary: false, content: result.buffer.toString('utf8') };
  }

  async openRawFile(hostId: string, root: string, relPath: string): Promise<ClientRawFileHandle> {
    const cleanRel = this.relPathFor(hostId, relPath);
    const meta = await this.stat(hostId, root, cleanRel);
    if (!meta.exists || meta.kind !== 'file' || meta.isSymlink) {
      throw new HttpError(404, '文件不存在或无法访问');
    }
    const size = meta.size ?? 0;
    const mtime = Math.floor(meta.mtimeMs ?? 0);
    let activeStream: MuxStream | undefined;
    let closed = false;

    const createReadStream = (range?: { start: number; end: number }): Readable => {
      const start = range?.start ?? 0;
      const length = range ? (range.end - range.start + 1) : size;
      if (length <= 0) return Readable.from([]);

      let started = false;
      const startStreaming = async () => {
        try {
          const stream = await this.registry.openStream(hostId, 'fs.read_stream', {
            root, path: cleanRel, offset: start, length,
          });
          activeStream = stream;
          if (closed) { void stream.cancel('consumer_closed'); return; }
          stream.onData(chunk => { if (!readable.destroyed) readable.push(chunk); });
          stream.onEof(() => {
            void stream.sendEof().catch(() => undefined);
            if (!readable.destroyed) readable.push(null);
          });
          stream.onCancel(error => { if (!readable.destroyed) readable.destroy(error); });
        } catch (error) {
          if (error instanceof RpcError && error.code === 'METHOD_NOT_FOUND') {
            try {
              let cursor = start;
              const endExclusive = start + length;
              while (cursor < endExclusive && !closed && !readable.destroyed) {
                const take = Math.min(STREAM_FALLBACK_CHUNK, endExclusive - cursor);
                const slice = await this.readSlice(hostId, root, cleanRel, cursor, take);
                if (!slice.buffer.length) break;
                readable.push(slice.buffer);
                cursor += slice.buffer.length;
              }
              if (!readable.destroyed) readable.push(null);
            } catch (fallbackError) {
              if (!readable.destroyed) readable.destroy(mapClientRpcError(fallbackError));
            }
            return;
          }
          if (!readable.destroyed) readable.destroy(mapClientRpcError(error));
        }
      };

      const readable = new Readable({
        // Start only after the consumer attaches listeners and begins reading so early errors cannot go unhandled.
        read() {
          if (started) return;
          started = true;
          void startStreaming();
        },
        destroy(err, callback) {
          closed = true;
          if (activeStream && !activeStream.closed) void activeStream.cancel('consumer_closed');
          callback(err);
        },
      });

      return readable;
    };

    return {
      actualPath: cleanRel,
      size,
      mtime,
      handle: {
        createReadStream,
        close: async () => {
          closed = true;
          if (activeStream && !activeStream.closed) await activeStream.cancel('handle_closed');
        },
      },
    };
  }

  async writeFile(hostId: string, params: ClientWriteParams): Promise<ClientWriteResult> {
    const cleanRel = this.relPathFor(hostId, params.path);
    return this.registry.callRpc<ClientWriteResult>(hostId, 'fs.write', { ...params, path: cleanRel }, { timeoutMs: 60_000 });
  }

  async editFile(hostId: string, params: {
    root: string; path: string; oldText: string; newText: string; replaceAll?: boolean;
  }): Promise<ClientEditResult> {
    const cleanRel = this.relPathFor(hostId, params.path);
    return this.registry.callRpc<ClientEditResult>(hostId, 'fs.edit', { ...params, path: cleanRel }, { timeoutMs: 60_000 });
  }

  async applyPatch(hostId: string, params: { root: string; patch: string; dryRun: boolean }): Promise<ClientApplyPatchResult> {
    const result = await this.registry.callRpc<Partial<ClientApplyPatchResult>>(hostId, 'fs.apply_patch', params, { timeoutMs: 60_000 });
    return {
      ok: result?.ok ?? true,
      files: Array.isArray(result?.files) ? result.files.map(String) : [],
      diff: String(result?.diff ?? ''),
      ...(typeof result?.hunks === 'number' ? { hunks: result.hunks } : {}),
      ...(typeof result?.error === 'string' ? { error: result.error } : {}),
    };
  }

  async glob(hostId: string, params: { root: string; pattern: string; cwd?: string; maxResults?: number }): Promise<ClientGlobResult> {
    const cwd = params.cwd ? this.relPathFor(hostId, params.cwd, true) : undefined;
    const result = await this.registry.callRpc<Partial<ClientGlobResult>>(
      hostId, 'search.glob', { ...params, ...(cwd ? { cwd } : {}) }, { timeoutMs: 60_000 },
    );
    return { matches: Array.isArray(result?.matches) ? result.matches.map(String) : [], truncated: Boolean(result?.truncated) };
  }

  async grep(hostId: string, params: {
    root: string; pattern: string; path?: string; glob?: string; caseInsensitive?: boolean; maxResults?: number;
  }): Promise<ClientGrepResult> {
    const rel = params.path ? this.relPathFor(hostId, params.path, true) : undefined;
    const result = await this.registry.callRpc<Partial<ClientGrepResult>>(
      hostId, 'search.grep', { ...params, ...(rel ? { path: rel } : {}) }, { timeoutMs: 60_000 },
    );
    return { matches: Array.isArray(result?.matches) ? result.matches : [], truncated: Boolean(result?.truncated) };
  }

  async manageTask(hostId: string, params: {
    sessionId: string; action: 'list' | 'status' | 'send_input' | 'kill'; taskId?: string; input?: string;
  }): Promise<unknown> {
    return this.registry.callRpc(hostId, 'exec.manage_task', params, { timeoutMs: 30_000 });
  }

  async deletePath(hostId: string, root: string, relPath: string, recursive = false): Promise<void> {
    const cleanRel = this.relPathFor(hostId, relPath);
    await this.registry.callRpc(hostId, 'fs.delete', { root, path: cleanRel, recursive });
  }

  async mkdir(hostId: string, root: string, relPath: string, recursive = true): Promise<void> {
    const cleanRel = this.relPathFor(hostId, relPath, true);
    await this.registry.callRpc(hostId, 'fs.mkdir', { root, path: cleanRel, recursive });
  }

  async gitStatus(hostId: string, root: string): Promise<GitSnapshot> {
    const result = await this.registry.callRpc<Partial<GitSnapshot>>(hostId, 'git.status', { root }, { timeoutMs: 60_000 });
    return {
      branch: String(result?.branch ?? ''),
      status: String(result?.status ?? ''),
      diff: String(result?.diff ?? ''),
    };
  }

  async gitWorktree<T = Record<string, unknown>>(hostId: string, request: ClientWorktreeRequest, timeoutMs = 300_000): Promise<T> {
    return this.registry.callRpc<T>(hostId, 'git.worktree', request, { timeoutMs });
  }

  async execCommand(hostId: string, params: ClientExecParams, timeoutMs = 300_000): Promise<ClientExecResult> {
    const result = await this.registry.callRpc<Partial<ClientExecResult>>(hostId, 'exec.command', params, { timeoutMs });
    return {
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 1,
      stdout: String(result?.stdout ?? ''),
      stderr: String(result?.stderr ?? ''),
      ...(result?.timedOut !== undefined ? { timedOut: Boolean(result.timedOut) } : {}),
      ...(result?.backgroundTaskId ? { backgroundTaskId: String(result.backgroundTaskId) } : {}),
    };
  }

  async openPty(hostId: string, params: {
    cwd: string; shell?: string; cols: number; rows: number; env?: Record<string, string>;
  }, signal?: AbortSignal): Promise<ClientPtyHandle> {
    const stream = await this.registry.openStream(hostId, 'pty.open', params, signal);
    const meta = stream.initialResult as { ptyId?: unknown } | undefined;
    const ptyId = typeof meta?.ptyId === 'string' && meta.ptyId ? meta.ptyId : String(stream.streamId);
    return { ptyId, stream };
  }

  async resizePty(hostId: string, params: { ptyId: string; streamId: number; cols: number; rows: number }): Promise<void> {
    await this.registry.callRpc(hostId, 'pty.resize', params);
  }

  async closePty(hostId: string, params: { ptyId: string; streamId: number }): Promise<void> {
    await this.registry.callRpc(hostId, 'pty.close', params).catch(() => undefined);
  }
}
