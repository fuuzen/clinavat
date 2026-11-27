import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../database.js';
import type { ExecutionHost } from '../execution/types.js';
import type { ClientDevice } from '../models.js';
import { openContained, openContainedDirectory, removeContainedFile, writeContainedFile } from '../runtime/contained-files.js';
import { atomicWrite } from '../runtime/process.js';
import { DEFAULT_IGNORES, ruleLines } from '../runtime/sync-policy.js';
import type { SkippedLinks, SyncProgress } from '../runtime/sync-status.js';
import type { RuntimeConfig, WorkspaceProject } from '../runtime/types.js';
import {
  BatchRecordDecoder, buildMirrorMatcher, encodeBatchRecord, filterRemoteScan, isLockFailure,
  MAX_SYNC_FILE_BYTES, parseGitignoreLines, reconcileTrees, safeMirrorRelPath, scanLocalMirror,
  type RemoteScanResponse, type RemoteSyncEntry, type SyncBaselineEntry,
} from './mirror-reconcile.js';
import { normalizePlatform } from './path-utils.js';
import type { ClientHostRegistry } from './registry.js';

export { encodeBatchRecord, MAX_SYNC_FILE_BYTES, type RemoteSyncEntry, type SyncBaselineEntry } from './mirror-reconcile.js';

interface SyncStateFile {
  version: 1;
  projectId: string;
  platform: string;
  remoteRoot: string;
  updatedAt: string;
  entries: Record<string, SyncBaselineEntry>;
}

interface PushBatchMeta {
  applied?: string[];
  warnings?: Array<{ path: string; code?: string; message: string }>;
  errors?: Array<{ path: string; code?: string; message: string }>;
  stats?: Record<string, { size: number; mtimeMs: number; sha256?: string }>;
}

interface ProjectSyncRuntime {
  paused: boolean;
  progress: SyncProgress;
  lastSyncedAt?: string;
  warnings: string[];
  errors: string[];
  skipped: SkippedLinks;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

const STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_PULL_TOTAL_PARTIAL_BYTES = 128 * 1024 * 1024;
const MAX_CONCURRENT_PARTIAL_FILES = 1024;

/** Bidirectional incremental sync engine for `client` + `mirrored` workspaces (replaces Mutagen). */
export class ClientMirrorSync {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly runtimes = new Map<string, ProjectSyncRuntime>();
  onSkippedLinks?: (project: WorkspaceProject, skipped: SkippedLinks) => void;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: Store,
    private readonly registry: ClientHostRegistry,
    private readonly execution: ExecutionHost,
  ) {}

  statePath(projectId: string): string {
    return join(this.config.workspaceDir, '.sync-state', `proj_${projectId}.json`);
  }

  private runtimeOf(projectId: string): ProjectSyncRuntime {
    let rt = this.runtimes.get(projectId);
    if (!rt) {
      rt = {
        paused: false,
        progress: { description: '正在准备双向同步', ratio: null },
        warnings: [], errors: [], skipped: { links: [], more: 0 },
        fileCount: 0, dirCount: 0, totalBytes: 0,
      };
      this.runtimes.set(projectId, rt);
    }
    return rt;
  }

  private serialized<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(projectId, tail);
    void tail.finally(() => { if (this.queues.get(projectId) === tail) this.queues.delete(projectId); });
    return next;
  }

  private platformOf(hostId: string): string {
    const active = this.registry.getSession(hostId);
    if (active) return normalizePlatform(active.platform);
    const device = this.store.get<ClientDevice>('SELECT platform FROM client_devices WHERE dev_host_id=?', hostId);
    return normalizePlatform(device?.platform);
  }

  private async loadBaseline(projectId: string): Promise<Record<string, SyncBaselineEntry>> {
    try {
      const raw = await readFile(this.statePath(projectId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<SyncStateFile>;
      return parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    } catch { return {}; }
  }

  private async saveBaseline(project: WorkspaceProject, platform: string, entries: Record<string, SyncBaselineEntry>): Promise<void> {
    await mkdir(join(this.config.workspaceDir, '.sync-state'), { recursive: true, mode: 0o700 });
    const payload: SyncStateFile = {
      version: 1, projectId: project.id, platform, remoteRoot: project.remote_path,
      updatedAt: new Date().toISOString(), entries,
    };
    await atomicWrite(this.statePath(project.id), JSON.stringify(payload), 0o600);
  }

  private async readLocalGitignore(root: string): Promise<string[]> {
    const opened = await openContained(root, '.gitignore', { followLinks: false }).catch(() => undefined);
    if (!opened) return [];
    try { return parseGitignoreLines(await opened.handle.readFile('utf8')); }
    catch { return []; }
    finally { await opened.handle.close(); }
  }

  async initialize(project: WorkspaceProject, prepareExecutor: () => Promise<void>, timeoutMs = 120_000): Promise<void> {
    const rt = this.runtimeOf(project.id);
    rt.paused = false;
    rt.progress = { description: '正在初始化本地镜像目录', ratio: 0 };
    await mkdir(project.local_path, { recursive: true, mode: 0o700 });
    await prepareExecutor();
    await this.flush(project, timeoutMs);
  }

  async flush(project: WorkspaceProject, timeoutMs = 120_000): Promise<void> {
    return this.serialized(project.id, () => this.runSync(project, timeoutMs));
  }

  private async runSync(project: WorkspaceProject, timeoutMs: number): Promise<void> {
    const rt = this.runtimeOf(project.id);
    if (rt.paused) return;
    rt.warnings = [];
    rt.errors = [];
    rt.progress = { description: '正在扫描客户端与本地镜像', ratio: 0.1 };
    const platform = this.platformOf(project.dev_host_id);
    await mkdir(project.local_path, { recursive: true, mode: 0o700 });

    const baseline = await this.loadBaseline(project.id);
    const baseIgnores = [...DEFAULT_IGNORES, ...ruleLines(project.sync_rules ?? ''), '/.bin', '.git'];
    const remoteScan = await this.registry.callRpc<RemoteScanResponse>(
      project.dev_host_id, 'sync.scan', { root: project.remote_path, ignores: baseIgnores, excludeVcs: true }, { timeoutMs },
    );
    const localGitignore = await this.readLocalGitignore(project.local_path);
    const matcher = buildMirrorMatcher(project.sync_rules, localGitignore, remoteScan.gitIgnored ?? []);

    const remote = filterRemoteScan(remoteScan, platform, matcher);
    const local = await scanLocalMirror(project.local_path, matcher);
    const excluded = new Set<string>([...remote.excluded, ...local.excluded]);
    const skippedLinks = [...remote.skippedLinks, ...local.skippedLinks];
    rt.warnings.push(...remote.warnings, ...local.warnings);

    const plan = await reconcileTrees({
      localRoot: project.local_path, platform, matcher, baseline, local,
      remoteFiles: remote.remoteFiles, remoteDirs: remote.remoteDirs, remoteSiblings: remote.remoteSiblings, excluded,
    });
    rt.warnings.push(...plan.warnings);

    // Every local mirror directory creation/deletion uses O_NOFOLLOW + /proc/self/fd containment.
    for (const dir of remote.remoteDirs) {
      const safeDir = safeMirrorRelPath(dir);
      if (!safeDir) continue;
      const created = await openContainedDirectory(project.local_path, safeDir.split('/'), true);
      await created.handle.close();
    }

    const totalOps = plan.toPull.length + plan.toPushWrite.length + plan.toPushDelete.length + plan.toPushMkdir.length;
    rt.progress = { description: totalOps ? '正在双向传输变更文件' : '文件已一致', ratio: totalOps ? 0.3 : 1, expectedFiles: totalOps, receivedFiles: 0 };

    const skippedOverflow = plan.toPull.length > 0
      ? await this.pullBatch(project, plan.toPull, remote.remoteFiles, plan.nextBaseline, rt)
      : new Set<string>();

    // Exclude any mid-stream overflowed paths from local deletions, remote pushes, and baseline mutation.
    for (const rel of skippedOverflow) {
      if (baseline[rel]) plan.nextBaseline[rel] = baseline[rel]!;
      else delete plan.nextBaseline[rel];
    }
    const toDeleteLocal = plan.toDeleteLocal.filter(rel => !skippedOverflow.has(rel));
    const toPushWrite = plan.toPushWrite.filter(item => !skippedOverflow.has(item.path));
    const toPushDelete = plan.toPushDelete.filter(rel => !skippedOverflow.has(rel));

    for (const rel of toDeleteLocal) {
      const safeRel = safeMirrorRelPath(rel);
      if (safeRel) await removeContainedFile(project.local_path, safeRel);
    }
    if (plan.toPushMkdir.length || toPushWrite.length || toPushDelete.length) {
      await this.pushBatch(project, plan.toPushMkdir, toPushWrite, toPushDelete, plan.nextBaseline, rt);
    }

    let totalBytes = 0;
    for (const item of Object.values(plan.nextBaseline)) totalBytes += item.size;
    rt.fileCount = Object.keys(plan.nextBaseline).length;
    rt.dirCount = new Set([...remote.remoteDirs, ...local.dirs]).size;
    rt.totalBytes = totalBytes;
    rt.lastSyncedAt = new Date().toISOString();
    rt.skipped = { links: skippedLinks, more: 0 };
    rt.progress = { description: '同步完成', ratio: 1, receivedFiles: totalOps, expectedFiles: totalOps, totalBytes };
    this.onSkippedLinks?.(project, rt.skipped);
    await this.saveBaseline(project, platform, plan.nextBaseline);
  }

  private async pullBatch(
    project: WorkspaceProject, paths: string[], remoteFiles: Map<string, RemoteSyncEntry>,
    nextBaseline: Record<string, SyncBaselineEntry>, rt: ProjectSyncRuntime,
  ): Promise<Set<string>> {
    const requested = new Set<string>();
    for (const candidate of paths) {
      const safe = safeMirrorRelPath(candidate);
      if (!safe) throw new Error(`拒绝拉取非法或受保护路径：${candidate}`);
      requested.add(safe);
    }
    const stream = await this.registry.openStream(project.dev_host_id, 'sync.pull_batch', {
      root: project.remote_path, paths: [...requested],
    });
    const decoder = new BatchRecordDecoder();
    const partials = new Map<string, { chunks: Buffer[]; totalBytes: number; mtimeMs?: number }>();
    const skippedOverflow = new Set<string>();
    let totalPartialBytes = 0;
    let completed = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let processing = Promise.resolve();
      const dropPartial = (rel: string) => {
        const current = partials.get(rel);
        if (!current) return;
        totalPartialBytes = Math.max(0, totalPartialBytes - current.totalBytes);
        partials.delete(rel);
      };
      const skipFileOverflow = (rel: string, reason: string) => {
        dropPartial(rel);
        skippedOverflow.add(rel);
        rt.warnings.push(reason);
      };
      const failOnce = (err: unknown) => {
        if (settled) return;
        settled = true;
        partials.clear();
        totalPartialBytes = 0;
        const failure = err instanceof Error ? err : new Error(String(err));
        void stream.cancel(failure.message).catch(() => undefined);
        reject(failure);
      };

      const applyRecord = async (header: Record<string, unknown>, body: Buffer) => {
        if (settled) return;
        const rawPath = String(header.path ?? '');
        const rel = safeMirrorRelPath(rawPath);
        if (!rel || !requested.has(rel)) {
          throw new Error(`客户端返回了未请求或受保护的同步路径：${rawPath}`);
        }
        if (skippedOverflow.has(rel)) return;
        if (typeof header.error === 'string' && header.error) {
          dropPartial(rel);
          const code = typeof header.code === 'string' ? header.code : undefined;
          const note = `拉取 ${rel} 失败：${header.error}`;
          if (isLockFailure(code, header.error)) rt.warnings.push(`文件被占用跳过：${note}`);
          else rt.errors.push(note);
          return;
        }
        const declaredSize = remoteFiles.get(rel)?.size;
        const growthCap = declaredSize !== undefined
          ? Math.min(MAX_SYNC_FILE_BYTES, Math.max(declaredSize * 2 + 1024 * 1024, 4 * 1024 * 1024))
          : MAX_SYNC_FILE_BYTES;
        let state = partials.get(rel);
        if (!state) {
          if (partials.size >= MAX_CONCURRENT_PARTIAL_FILES) throw new Error('同步并发未完成文件数超出上限');
          state = { chunks: [], totalBytes: 0, mtimeMs: Number(header.mtimeMs || 0) || undefined };
          partials.set(rel, state);
        }
        if (body.length > 0) {
          const nextFileBytes = state.totalBytes + body.length;
          if (nextFileBytes > MAX_SYNC_FILE_BYTES) {
            return skipFileOverflow(rel, `跳过超过 64 MiB 的文件：${rel}`);
          }
          if (nextFileBytes > growthCap) {
            return skipFileOverflow(rel, `跳过扫描后体积异常增大的文件：${rel}`);
          }
          if (totalPartialBytes + body.length > MAX_PULL_TOTAL_PARTIAL_BYTES) {
            return skipFileOverflow(rel, `同步拉取缓存超过 128 MiB 上限，已跳过文件：${rel}`);
          }
          state.totalBytes = nextFileBytes;
          totalPartialBytes += body.length;
          state.chunks.push(body);
        }
        if (header.done !== false) {
          dropPartial(rel);
          const content = state.chunks.length === 1 ? state.chunks[0]! : Buffer.concat(state.chunks);
          const mtimeMs = state.mtimeMs ?? remoteFiles.get(rel)?.mtimeMs ?? Date.now();
          const written = await writeContainedFile(project.local_path, rel, content, mtimeMs);
          nextBaseline[rel] = { size: written.size, mtimeMs: written.mtimeMs, sha256: remoteFiles.get(rel)?.sha256 };
          completed += 1;
          rt.progress = { description: '正在拉取客户端文件', ratio: Math.min(0.9, 0.3 + 0.5 * (completed / requested.size)), receivedFiles: completed, expectedFiles: requested.size };
        }
      };

      stream.onData(chunk => {
        if (settled) return;
        processing = processing.then(async () => {
          if (settled) return;
          for (const rec of decoder.push(chunk)) {
            if (settled) return;
            await applyRecord(rec.header, rec.body);
          }
        }).catch(failOnce);
      });
      stream.onEof(() => {
        void processing.then(() => {
          if (settled) return;
          settled = true;
          partials.clear();
          totalPartialBytes = 0;
          void stream.sendEof().catch(() => undefined);
          resolve();
        }).catch(failOnce);
      });
      stream.onCancel(err => failOnce(err));
    });
    return skippedOverflow;
  }

  private async pushBatch(
    project: WorkspaceProject, mkdirs: string[], writes: Array<{ path: string; size: number; mtimeMs: number }>,
    deletes: string[], nextBaseline: Record<string, SyncBaselineEntry>, rt: ProjectSyncRuntime,
  ): Promise<void> {
    const operations = [
      ...mkdirs.map(path => ({ op: 'mkdir' as const, path })),
      ...writes.map(item => ({ op: 'write' as const, path: item.path, size: item.size, mtimeMs: item.mtimeMs })),
      ...deletes.map(path => ({ op: 'delete' as const, path })),
    ];
    const stream = await this.registry.openStream(project.dev_host_id, 'sync.push_batch', { root: project.remote_path, operations });
    const responseMeta = new Promise<PushBatchMeta>((resolve, reject) => {
      stream.onEof(meta => resolve((meta && typeof meta === 'object' ? meta : {}) as PushBatchMeta));
      stream.onCancel(err => reject(err));
    });

    for (const item of writes) {
      const safeRel = safeMirrorRelPath(item.path);
      if (!safeRel) throw new Error(`拒绝推送非法或受保护路径：${item.path}`);
      const { handle, size } = await openContained(project.local_path, safeRel, { followLinks: false });
      try {
        const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        let pos = 0;
        if (size === 0) await stream.sendData(encodeBatchRecord({ path: safeRel, mtimeMs: item.mtimeMs, done: true }));
        else {
          while (pos < size) {
            const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
            if (!bytesRead) break;
            pos += bytesRead;
            await stream.sendData(encodeBatchRecord({ path: safeRel, mtimeMs: item.mtimeMs, done: pos >= size }, buf.subarray(0, bytesRead)));
          }
        }
      } finally { await handle.close(); }
    }
    await stream.sendEof();

    const meta = await responseMeta;
    const failed = new Set<string>();
    for (const warn of meta.warnings ?? []) { failed.add(warn.path); rt.warnings.push(`推送告警 ${warn.path}：${warn.message}`); }
    for (const err of meta.errors ?? []) {
      failed.add(err.path);
      if (isLockFailure(err.code, err.message)) rt.warnings.push(`文件被占用跳过 ${err.path}：${err.message}`);
      else rt.errors.push(`推送失败 ${err.path}：${err.message}`);
    }
    for (const item of writes) {
      if (failed.has(item.path)) continue;
      const remoteStat = meta.stats?.[item.path];
      nextBaseline[item.path] = { size: remoteStat?.size ?? item.size, mtimeMs: Math.floor(remoteStat?.mtimeMs ?? item.mtimeMs), sha256: remoteStat?.sha256 };
    }
  }

  async assertSynced(project: WorkspaceProject): Promise<void> {
    await this.flush(project);
    const rt = this.runtimeOf(project.id);
    if (rt.errors.length) throw new Error(`同步存在未解决错误：\n${rt.errors.join('\n')}`);
  }

  pause(project: WorkspaceProject): void { this.runtimeOf(project.id).paused = true; }

  status(project: WorkspaceProject): { status: 'WATCHING' | 'PAUSED' | 'ERROR' | 'SYNCING'; detail: string; skipped: SkippedLinks } {
    const rt = this.runtimeOf(project.id);
    const online = this.registry.isOnline(project.dev_host_id);
    const status = rt.paused ? 'PAUSED' : (!online || rt.errors.length > 0) ? 'ERROR' : 'WATCHING';
    const detail = [
      `同步状态：${rt.paused ? '已暂停' : !online ? '客户端离线' : rt.errors.length ? '存在同步错误' : '客户端双向增量同步正常'}`,
      `已同步 ${rt.fileCount} 个文件、${rt.dirCount} 个目录（${rt.totalBytes} B）`,
      ...(rt.lastSyncedAt ? [`上次同步：${rt.lastSyncedAt}`] : []),
      ...rt.errors.slice(0, 8),
      ...rt.warnings.slice(0, 8),
    ].join('\n');
    return { status, detail, skipped: rt.skipped };
  }

  progress(project: WorkspaceProject): SyncProgress { return this.runtimeOf(project.id).progress; }

  async remove(project: WorkspaceProject): Promise<void> {
    this.runtimes.delete(project.id);
    await rm(this.statePath(project.id), { force: true }).catch(() => undefined);
    await this.execution.revoke(project.user_id, [project.local_path]);
    await rm(project.local_path, { recursive: true, force: true });
  }
}
