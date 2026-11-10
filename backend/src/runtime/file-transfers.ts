import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../models.js';
import { descriptorPath, placeFile } from './contained-files.js';
import type { WorkspaceProject } from './types.js';
import type { WorkspaceManager } from './workspace.js';

/** Every proxy in front of the Hub accepts 1 MiB request bodies, so files arrive in chunks of at most this size. */
export const transferChunkBytes = 1024 * 1024;
// Staged data of a transfer left untouched this long (closed tab, lost connection) is removed.
const abandonedAfterMs = 60 * 60 * 1000;

export interface WrittenFile {
  path: string;
  size: number;
  mtime: number;
  etag: string;
}

/** `createOnly` never replaces an existing file; `expectedTag` replaces it only while it still has that version. */
export interface WriteCondition {
  createOnly?: boolean;
  expectedTag?: string;
}

export interface TransferChunk {
  path: string;
  /** Chosen by the client for one file; chunks of the same transfer accumulate in one staged file. */
  transfer: string;
  offset: number;
  size: number;
  condition: WriteCondition;
}

interface TargetPath {
  directory: string[];
  name: string;
}

export function fileTag({ size, mtime }: { size: number; mtime: number }): string {
  return `"${size.toString(36)}-${mtime.toString(36)}"`;
}

function targetPath(path: string): TargetPath {
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\0-\x1f]/.test(segment) || Buffer.byteLength(segment) > 255)) {
    throw new HttpError(400, '文件路径无效');
  }
  if (segments.some(segment => segment === '.bin' || segment === '.git')) throw new HttpError(403, '不能写入运行时目录或 Git 目录');
  return { directory: segments.slice(0, -1), name: segments.at(-1)! };
}

function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}

function enforce(existing: Stats | undefined, condition: WriteCondition): void {
  if (existing?.isDirectory()) throw new HttpError(409, '同名目录已存在');
  if (existing?.isSymbolicLink()) throw new HttpError(409, '目标是符号链接，不能写入');
  if (existing && !existing.isFile()) throw new HttpError(409, '目标不是普通文件');
  if (existing && condition.createOnly) throw new HttpError(412, '文件已存在');
  if (condition.expectedTag && (!existing || fileTag({ size: existing.size, mtime: Math.floor(existing.mtimeMs) }) !== condition.expectedTag)) {
    throw new HttpError(412, existing ? '文件已在其他地方被修改' : '文件已被删除');
  }
}

/** Filesystem errors carry absolute server paths, so only their kind is reported. */
export function transferFailure(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (!code) return error instanceof Error ? new HttpError(400, error.message) : error;
  const messages: Record<string, [number, string]> = {
    EEXIST: [412, '文件已存在'],
    ENOENT: [404, '目标目录不存在或已被移动'],
    ENOTDIR: [409, '路径中的某一级不是目录（可能是文件或符号链接）'],
    EISDIR: [409, '同名目录已存在'],
    ELOOP: [409, '路径中不能包含符号链接'],
    EACCES: [403, '没有写入权限'],
    EPERM: [403, '没有写入权限'],
    EROFS: [403, '目标位于只读文件系统'],
    ENOSPC: [507, '磁盘空间不足'],
    EDQUOT: [507, '磁盘配额已用完'],
    ENAMETOOLONG: [400, '文件名过长'],
  };
  const known = messages[code];
  return known ? new HttpError(...known) : error;
}

/**
 * Writes uploaded and edited files into project workspaces. Data is staged outside the project, where neither the
 * agents nor the sync can see a partial file, and moved into place once complete.
 */
export class FileTransfers {
  private readonly receiving = new Set<string>();
  // Beside the project mirrors, so moving a finished file into one is a rename rather than a copy.
  private readonly staging: string;

  constructor(private readonly workspaces: WorkspaceManager, readonly limitBytes: number) {
    this.staging = join(workspaces.config.workspaceDir, '.transfers');
  }

  private stagedPath(project: WorkspaceProject, transfer: string): string {
    return join(this.staging, `${project.id}.${transfer}`);
  }

  async receive(project: WorkspaceProject, chunk: TransferChunk, body: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<{ received: number; file?: WrittenFile }> {
    if (chunk.size > this.limitBytes) throw new HttpError(413, `文件超过 ${Math.floor(this.limitBytes / 1024 / 1024)} MiB 的上传上限`);
    if (chunk.offset > chunk.size) throw new HttpError(400, '上传偏移无效');
    const target = targetPath(chunk.path);
    const key = `${project.id}.${chunk.transfer}`;
    if (this.receiving.has(key)) throw new HttpError(409, '该文件的上一段仍在上传');
    this.receiving.add(key);
    try {
      if (chunk.offset === 0) {
        await this.sweep();
        // Checked before any data is staged, so a conflict surfaces without sending the whole file first.
        await this.precheck(project, target, chunk.condition);
      }
      const staged = this.stagedPath(project, chunk.transfer);
      const received = await this.append(staged, chunk, body);
      if (received < chunk.size) return { received };
      try { return { received, file: await this.place(project, chunk.path, target, staged, chunk.condition) }; }
      finally { await rm(staged, { force: true }); }
    } finally { this.receiving.delete(key); }
  }

  async discard(project: WorkspaceProject, transfer: string): Promise<void> {
    await rm(this.stagedPath(project, transfer), { force: true });
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - abandonedAfterMs;
    const names = await readdir(this.staging).catch(() => [] as string[]);
    await Promise.all(names.map(async name => {
      const staged = join(this.staging, name);
      const metadata = await lstat(staged).catch(() => undefined);
      if (metadata && metadata.mtimeMs < cutoff) await rm(staged, { force: true });
    }));
  }

  private async append(staged: string, chunk: TransferChunk, body: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<number> {
    await mkdir(this.staging, { recursive: true, mode: 0o700 });
    const handle = await open(staged, chunk.offset === 0 ? 'w' : 'r+').catch((error: NodeJS.ErrnoException) => {
      throw error.code === 'ENOENT' ? new HttpError(409, '上传已失效，请重新上传') : error;
    });
    let position = chunk.offset;
    try {
      // A retried chunk rewrites from its offset; a gap means earlier chunks never arrived.
      if ((await handle.stat()).size < chunk.offset) throw new HttpError(409, '上传数据不连续，请重新上传');
      await handle.truncate(chunk.offset);
      for await (const data of body) {
        if (position + data.length - chunk.offset > transferChunkBytes) throw new HttpError(413, '单次上传的数据超过 1 MiB');
        if (position + data.length > chunk.size) throw new HttpError(413, '上传数据超过声明的大小');
        await handle.write(data, 0, data.length, position);
        position += data.length;
      }
      return position;
    } catch (error) {
      await handle.truncate(chunk.offset).catch(() => undefined);
      throw error;
    } finally { await handle.close(); }
  }

  /** Before staging, a missing parent directory only means it will be created along with the file. */
  private async precheck(project: WorkspaceProject, target: TargetPath, condition: WriteCondition): Promise<void> {
    const directory = await this.workspaces.writableDirectory(project, target.directory, false).catch(missing);
    if (!directory) return enforce(undefined, condition);
    try { enforce(await lstat(join(descriptorPath(directory.handle), target.name)).catch(missing), condition); }
    finally { await directory.handle.close(); }
  }

  private async place(project: WorkspaceProject, path: string, target: TargetPath, staged: string, condition: WriteCondition): Promise<WrittenFile> {
    const directory = await this.workspaces.writableDirectory(project, target.directory, true);
    try {
      const entry = join(descriptorPath(directory.handle), target.name);
      const existing = await lstat(entry).catch(missing);
      enforce(existing, condition);
      // Replacing keeps the file's permissions, so an edited script stays executable.
      if (existing) await chmod(staged, existing.mode & 0o777);
      await placeFile(directory.handle, target.name, staged, !!existing);
      const written = await lstat(entry);
      const result = { path, size: written.size, mtime: Math.floor(written.mtimeMs) };
      return { ...result, etag: fileTag(result) };
    } finally { await directory.handle.close(); }
  }
}
