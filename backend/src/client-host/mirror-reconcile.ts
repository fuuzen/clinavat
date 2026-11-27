import { createHash } from 'node:crypto';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { descriptorPath, openContained } from '../runtime/contained-files.js';
import { DEFAULT_IGNORES, ruleLines } from '../runtime/sync-policy.js';
import { IgnoreMatcher } from '../runtime/sync-scan.js';
import type { SkippedLink } from '../runtime/sync-status.js';
import { assertPortableFilename, isProtectedInternalSegment, normalizeRelativePath } from './path-utils.js';

export interface SyncBaselineEntry { size: number; mtimeMs: number; sha256?: string }

export interface RemoteSyncEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  mtimeMs: number;
  sha256?: string;
  linkTarget?: string;
}

export interface RemoteScanResponse {
  entries: RemoteSyncEntry[];
  skippedLinks?: Array<{ path: string; reason: string }>;
  skippedLarge?: string[];
  gitIgnored?: string[];
}

export interface LocalScanResult {
  files: Map<string, { size: number; mtimeMs: number }>;
  dirs: Set<string>;
  skippedLinks: SkippedLink[];
  excluded: Set<string>;
  warnings: string[];
}

export interface FilteredRemoteScan {
  remoteFiles: Map<string, RemoteSyncEntry>;
  remoteDirs: Set<string>;
  remoteSiblings: Map<string, Set<string>>;
  skippedLinks: SkippedLink[];
  excluded: Set<string>;
  warnings: string[];
}

export interface ReconcilePlan {
  toPull: string[];
  toDeleteLocal: string[];
  toPushWrite: Array<{ path: string; size: number; mtimeMs: number }>;
  toPushDelete: string[];
  toPushMkdir: string[];
  nextBaseline: Record<string, SyncBaselineEntry>;
  warnings: string[];
}

const MTIME_EPSILON_MS = 1000;
const LOCK_ERROR_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'SHARING_VIOLATION', 'LOCK_VIOLATION']);
export const MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BATCH_HEADER_BYTES = 64 * 1024;
export const MAX_BATCH_BODY_BYTES = 4 * 1024 * 1024;

export function safeMirrorRelPath(raw: string, platform?: string): string | null {
  try { return normalizeRelativePath(raw, { platform }); }
  catch { return null; }
}

/** Encodes one binary batch record: `[u32BE headerLen][UTF-8 JSON header][u32BE bodyLen][body]`. */
export function encodeBatchRecord(header: Record<string, unknown>, body: Buffer = Buffer.alloc(0)): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(4 + headerBuf.length + 4 + body.length);
  out.writeUInt32BE(headerBuf.length, 0);
  headerBuf.copy(out, 4);
  out.writeUInt32BE(body.length, 4 + headerBuf.length);
  if (body.length > 0) body.copy(out, 8 + headerBuf.length);
  return out;
}

/** Streaming decoder for `[u32BE headerLen][JSON header][u32BE bodyLen][body]` records with strict header/body bounds. */
export class BatchRecordDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly maxHeaderBytes = MAX_BATCH_HEADER_BYTES,
    private readonly maxBodyBytes = MAX_BATCH_BODY_BYTES,
  ) {}

  push(chunk: Buffer): Array<{ header: Record<string, unknown>; body: Buffer }> {
    if (chunk.length > 0) this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const records: Array<{ header: Record<string, unknown>; body: Buffer }> = [];
    while (this.buffer.length >= 4) {
      const headerLen = this.buffer.readUInt32BE(0);
      if (headerLen === 0 || headerLen > this.maxHeaderBytes) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`同步记录头长度超出上限 (${headerLen} > ${this.maxHeaderBytes})`);
      }
      if (this.buffer.length < 4 + headerLen + 4) break;
      const bodyLen = this.buffer.readUInt32BE(4 + headerLen);
      if (bodyLen > this.maxBodyBytes) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`同步记录体长度超出上限 (${bodyLen} > ${this.maxBodyBytes})`);
      }
      const total = 8 + headerLen + bodyLen;
      if (this.buffer.length < total) break;
      const header = JSON.parse(this.buffer.subarray(4, 4 + headerLen).toString('utf8')) as Record<string, unknown>;
      const body = Buffer.from(this.buffer.subarray(8 + headerLen, total));
      this.buffer = this.buffer.subarray(total);
      records.push({ header, body });
    }
    return records;
  }
}

export function isLockFailure(code?: string, message?: string): boolean {
  if (code && LOCK_ERROR_CODES.has(code.toUpperCase())) return true;
  return !!message && /EBUSY|EACCES|sharing violation|being used by another process/i.test(message);
}

export function parseGitignoreLines(content: string): string[] {
  return content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

export function buildMirrorMatcher(syncRules: string | null, gitignoreLines: string[], gitIgnored: string[]): IgnoreMatcher {
  return new IgnoreMatcher([
    ...DEFAULT_IGNORES,
    ...gitignoreLines,
    ...gitIgnored.map(p => '/' + p.replace(/\/$/, '')),
    ...ruleLines(syncRules ?? ''),
    '/.bin', '.git', '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  ]);
}

/** Normalizes remote `sync.scan` results and isolates >64 MiB files into `excluded` so reconciliation never overwrites them. */
export function filterRemoteScan(remoteScan: RemoteScanResponse, platform: string, matcher: IgnoreMatcher): FilteredRemoteScan {
  const remoteFiles = new Map<string, RemoteSyncEntry>();
  const remoteDirs = new Set<string>();
  const remoteSiblings = new Map<string, Set<string>>();
  const excluded = new Set<string>();
  const warnings: string[] = [];
  const skippedLinks: SkippedLink[] = (remoteScan.skippedLinks ?? []).map(item => ({
    side: 'alpha', path: item.path, reason: item.reason,
  }));
  const recordSibling = (rel: string) => {
    const parent = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    let siblings = remoteSiblings.get(parent);
    if (!siblings) { siblings = new Set(); remoteSiblings.set(parent, siblings); }
    siblings.add(posix.basename(rel));
  };

  for (const rawLarge of remoteScan.skippedLarge ?? []) {
    const rel = safeMirrorRelPath(String(rawLarge ?? '').replace(/^\/+/, '').replace(/\/+$/, ''), platform);
    if (!rel || matcher.ignored(rel, false)) continue;
    if (!excluded.has(rel)) {
      excluded.add(rel);
      recordSibling(rel);
      warnings.push(`跳过超过 64 MiB 的远端文件：${rel}`);
    }
  }

  for (const entry of remoteScan.entries ?? []) {
    const rel = safeMirrorRelPath(String(entry.path ?? '').replace(/^\/+/, '').replace(/\/+$/, ''), platform);
    if (!rel) continue;
    if (entry.kind === 'symlink') {
      skippedLinks.push({ side: 'alpha', path: rel, reason: `不可移植软链接（目标：${entry.linkTarget || '未知'}）` });
      continue;
    }
    if (matcher.ignored(rel, entry.kind === 'directory')) continue;
    recordSibling(rel);
    if (entry.kind === 'file' && entry.size > MAX_SYNC_FILE_BYTES) {
      if (!excluded.has(rel)) {
        excluded.add(rel);
        warnings.push(`跳过超过 64 MiB 的远端文件：${rel}`);
      }
      continue;
    }
    if (excluded.has(rel)) continue;
    if (entry.kind === 'directory') remoteDirs.add(rel);
    else remoteFiles.set(rel, { ...entry, path: rel });
  }
  return { remoteFiles, remoteDirs, remoteSiblings, skippedLinks, excluded, warnings };
}

async function sha256ContainedFile(root: string, relPath: string): Promise<string> {
  const hash = createHash('sha256');
  const { handle } = await openContained(root, relPath, { followLinks: false });
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pos = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

function entryChanged(entry: { size: number; mtimeMs: number; sha256?: string }, base?: SyncBaselineEntry): boolean {
  if (!base) return true;
  if (entry.size !== base.size) return true;
  if (entry.sha256 && base.sha256) return entry.sha256 !== base.sha256;
  return Math.abs(entry.mtimeMs - base.mtimeMs) > MTIME_EPSILON_MS;
}

/** Scans the local mirror strictly via `openContained` + `/proc/self/fd`, never traversing symbolic links. */
export async function scanLocalMirror(root: string, matcher: IgnoreMatcher): Promise<LocalScanResult> {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  const dirs = new Set<string>();
  const skippedLinks: SkippedLink[] = [];
  const excluded = new Set<string>();
  const warnings: string[] = [];

  const walk = async (relDir: string): Promise<void> => {
    const opened = await openContained(root, relDir || '.', { directory: true, followLinks: false }).catch(() => undefined);
    if (!opened) return;
    const subdirs: string[] = [];
    try {
      const dirFdPath = descriptorPath(opened.handle);
      const entries = await readdir(dirFdPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (isProtectedInternalSegment(entry.name)) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const entryFdPath = join(dirFdPath, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await readlink(entryFdPath).catch(() => '');
          skippedLinks.push({ side: 'beta', path: rel, reason: `不可移植软链接（目标：${target || '未知'}）` });
          continue;
        }
        const isDir = entry.isDirectory();
        if (matcher.ignored(rel, isDir)) continue;
        if (isDir) { dirs.add(rel); subdirs.push(rel); }
        else if (entry.isFile()) {
          const st = await lstat(entryFdPath).catch(() => undefined);
          if (st?.isFile() && !st.isSymbolicLink()) {
            if (st.size > MAX_SYNC_FILE_BYTES) {
              excluded.add(rel);
              warnings.push(`跳过超过 64 MiB 的本地文件：${rel}`);
            } else {
              files.set(rel, { size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
            }
          }
        }
      }
    } finally { await opened.handle.close(); }
    for (const next of subdirs) await walk(next);
  };
  await walk('');
  return { files, dirs, skippedLinks, excluded, warnings };
}

/** Computes a three-way bidirectional sync plan across baseline, local mirror, and remote client snapshot. */
export async function reconcileTrees(options: {
  localRoot: string;
  platform: string;
  matcher: IgnoreMatcher;
  baseline: Record<string, SyncBaselineEntry>;
  local: LocalScanResult;
  remoteFiles: Map<string, RemoteSyncEntry>;
  remoteDirs: Set<string>;
  remoteSiblings: Map<string, Set<string>>;
  excluded?: ReadonlySet<string>;
}): Promise<ReconcilePlan> {
  const { localRoot, platform, matcher, baseline, local, remoteFiles, remoteDirs, remoteSiblings, excluded } = options;
  const toPull: string[] = [];
  const toDeleteLocal: string[] = [];
  const toPushWrite: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const toPushDelete: string[] = [];
  const toPushMkdir: string[] = [];
  const nextBaseline: Record<string, SyncBaselineEntry> = {};
  const warnings: string[] = [];

  const addSibling = (rel: string) => {
    const parent = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    let set = remoteSiblings.get(parent);
    if (!set) { set = new Set(); remoteSiblings.set(parent, set); }
    set.add(posix.basename(rel));
  };

  const allPaths = new Set<string>([
    ...Object.keys(baseline), ...local.files.keys(), ...remoteFiles.keys(), ...(excluded ?? []),
  ]);
  for (const rel of [...allPaths].sort()) {
    if (matcher.ignored(rel, false)) continue;
    // Isolated oversized paths must never trigger pulls, pushes, or deletions, and preserve any prior baseline.
    if (excluded?.has(rel)) {
      if (baseline[rel]) nextBaseline[rel] = baseline[rel]!;
      continue;
    }
    const base = baseline[rel];
    const l = local.files.get(rel);
    const r = remoteFiles.get(rel);
    const parent = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);

    if (l && !r) {
      if (base && !entryChanged(l, base)) {
        toDeleteLocal.push(rel);
      } else {
        if (base) warnings.push(`同步冲突（本地修改、远端已删除），保留本地版本：${rel}`);
        try {
          assertPortableFilename(platform, rel, remoteSiblings.get(parent));
          addSibling(rel);
          toPushWrite.push({ path: rel, size: l.size, mtimeMs: l.mtimeMs });
        } catch (error) {
          warnings.push(`跳过不可移植文件 ${rel}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (!l && r) {
      if (base && !entryChanged(r, base)) toPushDelete.push(rel);
      else {
        if (base) warnings.push(`同步冲突（远端修改、本地已删除），恢复远端版本：${rel}`);
        toPull.push(rel);
      }
    } else if (l && r) {
      const lChanged = entryChanged(l, base);
      const rChanged = entryChanged(r, base);
      if (!lChanged && !rChanged) {
        nextBaseline[rel] = { size: l.size, mtimeMs: l.mtimeMs, sha256: r.sha256 ?? base?.sha256 };
      } else if (lChanged && !rChanged) {
        try {
          assertPortableFilename(platform, rel, remoteSiblings.get(parent));
          toPushWrite.push({ path: rel, size: l.size, mtimeMs: l.mtimeMs });
        } catch (error) {
          warnings.push(`跳过不可移植文件 ${rel}：${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (!lChanged && rChanged) {
        toPull.push(rel);
      } else {
        const localHash = r.sha256 ? await sha256ContainedFile(localRoot, rel).catch(() => undefined) : undefined;
        if (l.size === r.size && localHash && localHash === r.sha256) {
          nextBaseline[rel] = { size: l.size, mtimeMs: l.mtimeMs, sha256: localHash };
        } else if (l.mtimeMs >= r.mtimeMs) {
          warnings.push(`双向冲突，采用较新的本地版本：${rel}`);
          toPushWrite.push({ path: rel, size: l.size, mtimeMs: l.mtimeMs });
        } else {
          warnings.push(`双向冲突，采用较新的远端版本：${rel}`);
          toPull.push(rel);
        }
      }
    }
  }

  for (const dir of local.dirs) {
    if (remoteDirs.has(dir)) continue;
    const parent = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
    try {
      assertPortableFilename(platform, dir, remoteSiblings.get(parent));
      addSibling(dir);
      toPushMkdir.push(dir);
    } catch (error) {
      warnings.push(`跳过不可移植目录 ${dir}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { toPull, toDeleteLocal, toPushWrite, toPushDelete, toPushMkdir, nextBaseline, warnings };
}
