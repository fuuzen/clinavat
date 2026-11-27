import { access, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentWorkspaceBridge } from '../agent/types.js';
import type { ClientMirrorSync } from '../client-host/mirror-sync.js';
import { assertClientPath } from '../client-host/path-utils.js';
import type { ClientHostRegistry } from '../client-host/registry.js';
import type { ClientRawFileHandle, ClientStatResult, ClientWorkspaceAdapter } from '../client-host/workspace-adapter.js';
import type { Store } from '../database.js';
import type { ExecutionHost, ExecutionScope } from '../execution/types.js';
import type { ClientDevice, Host } from '../models.js';
import { descriptorPath, openContained, openContainedDirectory, type ContainedFile } from './contained-files.js';
import { atomicWrite, childEnvironment, runCommand } from './process.js';
import { prepareRemotePath, remoteCommand } from './remote-paths.js';
import { renderClientRemoteShell, renderRemoteShell } from './remote-shell.js';
import { SshManager } from './ssh.js';
import { loadSyncPolicy } from './sync-policy.js';
import { pruneChangedPaths } from './sync-rules.js';
import { parseSyncProgress, parseSyncStatus, summarizeSyncFailure, syncBlockers, type SkippedLinks, type SyncProgress } from './sync-status.js';
import { assertHostOwner, assertIdentifier, assertRemotePath, assertSshHost, type DevHost, type RuntimeConfig, type WorkspaceProject } from './types.js';

interface SessionSummary {
  labels?: Record<string, string>;
  ignore?: { paths?: string[] };
  alpha?: { path?: string };
}

export interface ClientWorkspaceSupport {
  store: Store;
  registry: ClientHostRegistry;
  adapter: ClientWorkspaceAdapter;
  mirror: ClientMirrorSync;
  clientExecSocketPath: string;
  clientExecTokenFor?: (projectId: string) => string;
}

export type WorkspaceRawFile = ContainedFile | ClientRawFileHandle;

export class WorkspaceManager {
  private readonly initializations = new Map<string, Promise<void>>();
  /** Receives the symbolic links each status reading finds skipped, including an empty list once they are gone. */
  onSkippedLinks?: (project: WorkspaceProject, skipped: SkippedLinks) => void;

  constructor(
    readonly config: RuntimeConfig,
    readonly ssh: SshManager,
    readonly execution: ExecutionHost,
    private readonly client?: ClientWorkspaceSupport,
  ) {}

  get clientAdapter(): ClientWorkspaceAdapter | undefined { return this.client?.adapter; }
  get clientRegistry(): ClientHostRegistry | undefined { return this.client?.registry; }

  agentBridge(): AgentWorkspaceBridge | undefined {
    const adapter = this.client?.adapter;
    if (!adapter) return undefined;
    return {
      readSlice: (h, r, p, o, m) => adapter.readSlice(h, r, p, o, m),
      stat: (h, r, p) => adapter.stat(h, r, p),
      listFiles: (h, r, p) => adapter.listFiles(h, r, p),
      writeFile: (h, p) => adapter.writeFile(h, p),
      editFile: (h, p) => adapter.editFile(h, p),
      applyPatch: (h, p) => adapter.applyPatch(h, p),
      glob: (h, p) => adapter.glob(h, p),
      grep: (h, p) => adapter.grep(h, p),
      execCommand: (h, p, t) => adapter.execCommand(h, p, t),
      manageTask: (h, p) => adapter.manageTask(h, p),
    };
  }

  private hostKindOf(hostId: string): 'ssh' | 'local' | 'client' {
    if (!this.client) return 'ssh';
    const row = this.client.store.get<Pick<Host, 'kind'>>('SELECT kind FROM dev_hosts WHERE id=?', hostId);
    return row?.kind ?? 'ssh';
  }

  clientPlatform(hostId: string): string {
    const active = this.client?.registry.getSession(hostId);
    if (active) return active.platform;
    const device = this.client?.store.get<Pick<ClientDevice, 'platform'>>('SELECT platform FROM client_devices WHERE dev_host_id=?', hostId);
    return device?.platform ?? 'linux';
  }

  isClientHost(hostId: string): boolean { return this.hostKindOf(hostId) === 'client'; }
  isClientDirect(project: WorkspaceProject): boolean { return this.isClientHost(project.dev_host_id) && project.client_mode !== 'mirrored'; }
  isClientMirrored(project: WorkspaceProject): boolean { return this.isClientHost(project.dev_host_id) && project.client_mode === 'mirrored'; }

  private validate(project: WorkspaceProject): void {
    assertIdentifier(project.id);
    assertIdentifier(project.user_id);
    assertIdentifier(project.dev_host_id);
    assertIdentifier(project.sync_name);
    if (this.isClientHost(project.dev_host_id)) {
      assertClientPath(this.clientPlatform(project.dev_host_id), project.remote_path);
    } else {
      assertRemotePath(project.remote_path);
    }
    if (project.execution_mode === 'local') {
      if (project.local_path !== project.remote_path || resolve(project.local_path) !== project.local_path) {
        throw new Error('本机项目必须直接使用实际工作目录');
      }
      return;
    }
    const workspaceRoot = resolve(this.config.workspaceDir);
    const child = relative(workspaceRoot, resolve(project.local_path));
    if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('工作区路径不在受管理的目录内');
  }

  private async mutagen(project: WorkspaceProject, args: string[], timeout = 60_000) {
    this.validate(project);
    if (project.execution_mode === 'local' || this.isClientHost(project.dev_host_id)) {
      throw new Error('该项目不使用 Mutagen 文件同步');
    }
    const scope = this.scope(project);
    const binary = await this.execution.binary(scope, 'mutagen');
    const result = await this.execution.run(binary, args, {
      scope, env: await this.ssh.mutagenEnvironment(project.user_id), timeout,
    });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${binary} 退出码 ${result.code}`).trim().slice(0, 4000));
    return result;
  }

  private scope(project: WorkspaceProject): ExecutionScope {
    return { userId: project.user_id, paths: [project.local_path] };
  }

  /** `flushTimeout` bounds the wait for the first full sync of a new session, in milliseconds. */
  async create(userId: string, host: DevHost, project: WorkspaceProject, flushTimeout = 120_000): Promise<void> {
    const existing = this.initializations.get(project.id);
    if (existing) return existing;
    const task = this.initialize(userId, host, project, flushTimeout);
    this.initializations.set(project.id, task);
    try { await task; } finally { this.initializations.delete(project.id); }
  }

  async refreshExecutor(project: WorkspaceProject, host: DevHost): Promise<void> {
    this.validate(project);
    assertHostOwner(project.user_id, host);
    if (host.kind === 'client') {
      if (project.client_mode !== 'mirrored') return;
      if (!this.client) throw new Error('客户端镜像执行服务未就绪');
      await this.writeRemoteShell(project, renderClientRemoteShell(project, this.client.clientExecSocketPath, this.client.clientExecTokenFor?.(project.id)));
      return;
    }
    if ((host.kind === 'local') !== (project.execution_mode === 'local')) throw new Error('本机项目与开发机类型不匹配');
    if (project.execution_mode === 'local') return;
    assertSshHost(host);
    const environment = await this.ssh.mutagenEnvironment(project.user_id);
    await this.writeRemoteShell(project, renderRemoteShell({
      ssh: await this.execution.binary(this.scope(project), 'ssh'), mutagen: await this.execution.binary(this.scope(project), 'mutagen'),
    }, project, this.ssh.configPath(project.user_id), this.ssh.alias(host), environment, this.execution.kind === 'vm' ? 'relay' : 'local'));
  }

  private async writeRemoteShell(project: WorkspaceProject, content: string): Promise<void> {
    const binDirectory = join(project.local_path, '.bin');
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    const binMetadata = await lstat(binDirectory);
    if (!binMetadata.isDirectory() || binMetadata.isSymbolicLink()) throw new Error('项目执行器目录必须是实际目录');
    await atomicWrite(join(binDirectory, 'remote-shell'), content, 0o500);
  }

  private missingSession(error: unknown, project: WorkspaceProject): boolean {
    return error instanceof Error && error.message.includes(`specification "${project.sync_name}" did not match any sessions`);
  }

  private async session(project: WorkspaceProject): Promise<SessionSummary | undefined> {
    try {
      const result = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}']);
      const sessions = JSON.parse(result.stdout) as SessionSummary[];
      if (!Array.isArray(sessions) || sessions.length !== 1) throw new Error('无法识别项目同步会话');
      return sessions[0];
    } catch (error) {
      if (this.missingSession(error, project)) return undefined;
      throw error;
    }
  }

  private async initialize(userId: string, host: DevHost, project: WorkspaceProject, flushTimeout: number): Promise<void> {
    this.validate(project);
    assertHostOwner(userId, host);
    if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
    if (host.kind === 'client') {
      if (!this.client) throw new Error('客户端工作区服务未就绪');
      if (project.client_mode !== 'mirrored') return;
      this.client.mirror.onSkippedLinks = this.onSkippedLinks;
      await this.client.mirror.initialize(project, () => this.refreshExecutor(project, host), flushTimeout);
      return;
    }
    if (host.kind === 'local' || project.execution_mode === 'local') {
      if (host.kind !== 'local' || project.execution_mode !== 'local') throw new Error('本机项目与开发机类型不匹配');
      await this.checkLocalDirectory(project);
      return;
    }
    assertSshHost(host);
    if (project.sync_rules === null) throw new Error('项目排除规则尚未迁移，请重新同步');
    await this.ssh.addHost(userId, host);
    const policy = await loadSyncPolicy(this.config, this.ssh, userId, host, project.remote_path, project.sync_rules);
    project.execution_mode = await prepareRemotePath(this.config, this.ssh, userId, host, project);
    const session = await this.session(project);
    const reuse = session?.labels?.['clinavat-policy'] === policy.fingerprint;
    if (session) {
      await this.mutagen(project, ['sync', 'resume', project.sync_name]);
      if (reuse) await this.flush(project);
      else {
        const sameRoot = session.alpha?.path === policy.remotePath;
        if (sameRoot) await this.assertSynced(project);
        else await this.flushBarrier(project);
        await this.mutagen(project, ['sync', 'terminate', project.sync_name]);
        if (sameRoot) await pruneChangedPaths(project.local_path, session.ignore?.paths ?? [], policy.ignores);
        else await this.clearMirror(project);
      }
    } else await this.clearMirror(project);
    await mkdir(project.local_path, { recursive: true, mode: 0o700 });
    await this.refreshExecutor(project, host);
    if (reuse) return;
    let created = false;
    try {
      await this.mutagen(project, [
        'sync', 'create', '--name', project.sync_name, '--sync-mode', 'two-way-resolved',
        '--label', `clinavat-policy=${policy.fingerprint}`,
        '--no-global-configuration', '--ignore-vcs',
        ...policy.ignores.flatMap(pattern => ['--ignore', pattern]),
        `${this.ssh.alias(host)}:${policy.remotePath}`, project.local_path,
      ], 120_000);
      created = true;
      await this.flush(project, flushTimeout);
    } catch (error) {
      if (created) await this.mutagen(project, ['sync', 'terminate', project.sync_name], 15_000).catch(() => undefined);
      throw error;
    }
  }

  private async flushBarrier(project: WorkspaceProject, timeout = 120_000): Promise<void> {
    try { await this.mutagen(project, ['sync', 'flush', project.sync_name], timeout); }
    catch (error) {
      const diagnosis = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}'], 10_000)
        .then(result => summarizeSyncFailure(result.stdout)).catch(() => '');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnosis ? `\n${diagnosis}` : ''}`);
    }
  }

  /** Waits for a full sync cycle, then requires that the mirror holds nothing the remote lacks. */
  async assertSynced(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    if (this.isClientDirect(project)) return;
    if (this.isClientMirrored(project)) {
      await this.client!.mirror.assertSynced(project);
      return;
    }
    await this.flushBarrier(project);
    const result = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}']);
    const blockers = syncBlockers(result.stdout);
    if (blockers.length) throw new Error(`同步尚未完成，镜像中可能有未同步的修改：\n${blockers.join('\n')}`);
  }

  private async clearMirror(project: WorkspaceProject): Promise<void> {
    const entries = await readdir(project.local_path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (!entries.some(name => name !== '.bin')) return;
    await this.execution.revoke(project.user_id, [project.local_path]);
    await rm(project.local_path, { recursive: true, force: true });
  }

  async flush(project: WorkspaceProject, timeout?: number): Promise<void> {
    this.validate(project);
    if (this.isClientDirect(project)) return;
    if (this.isClientMirrored(project)) {
      this.client!.mirror.onSkippedLinks = this.onSkippedLinks;
      return this.client!.mirror.flush(project, timeout);
    }
    if (project.execution_mode === 'local') return this.checkLocalDirectory(project);
    await this.flushBarrier(project, timeout);
    const health = await this.status(project);
    if (health.status === 'ERROR') throw new Error(`项目同步存在未解决的问题：\n${health.detail}`);
  }

  async pause(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    if (this.isClientDirect(project) || project.execution_mode === 'local') return;
    if (this.isClientMirrored(project)) { this.client!.mirror.pause(project); return; }
    try { await this.mutagen(project, ['sync', 'pause', project.sync_name]); }
    catch (error) { if (!this.missingSession(error, project)) throw error; }
  }

  async status(project: WorkspaceProject): Promise<{ status: string; detail: string }> {
    this.validate(project);
    if (this.isClientDirect(project)) return { status: 'READY', detail: '客户端直连模式，文件实时通过客户端访问，无需同步' };
    if (this.isClientMirrored(project)) {
      const health = this.client!.mirror.status(project);
      this.onSkippedLinks?.(project, health.skipped);
      return health;
    }
    if (project.execution_mode === 'local') { await this.checkLocalDirectory(project); return { status: 'LOCAL', detail: '直接使用本机目录，无需同步' }; }
    const result = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}']);
    const health = parseSyncStatus(result.stdout);
    this.onSkippedLinks?.(project, health.skipped);
    return health;
  }

  async progress(project: WorkspaceProject): Promise<SyncProgress> {
    this.validate(project);
    if (this.isClientDirect(project)) return { description: '客户端直连模式无需同步', ratio: 1 };
    if (this.isClientMirrored(project)) return this.client!.mirror.progress(project);
    try { return parseSyncProgress((await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}'], 10_000)).stdout); }
    catch (error) {
      if (this.missingSession(error, project)) return { description: '正在准备远端目录和同步规则', ratio: null };
      throw error;
    }
  }

  async remove(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    if (project.execution_mode === 'local') return;
    if (this.isClientHost(project.dev_host_id)) return this.client!.mirror.remove(project);
    try { await this.mutagen(project, ['sync', 'terminate', project.sync_name]); }
    catch (error) { if (!this.missingSession(error, project)) throw error; }
    await this.execution.revoke(project.user_id, [project.local_path]);
    await rm(project.local_path, { recursive: true, force: true });
  }

  async stopDaemon(userId: string): Promise<void> {
    if (this.execution.kind !== 'process') return;
    const scope: ExecutionScope = { userId, paths: [] };
    await this.execution.run(await this.execution.binary(scope, 'mutagen'), ['daemon', 'stop'], {
      scope, env: await this.ssh.mutagenEnvironment(userId), timeout: 30_000,
    });
  }

  async usage(project: WorkspaceProject): Promise<{ mirrorBytes: number | null }> {
    this.validate(project);
    if (project.execution_mode === 'local' || this.isClientDirect(project)) return { mirrorBytes: null };
    return { mirrorBytes: await diskUsage([project.local_path]) };
  }

  private async openProjectPath(project: WorkspaceProject, path: string, directory = false, followLinks = true): Promise<ContainedFile> {
    this.validate(project);
    if (project.execution_mode === 'local') await this.checkLocalDirectory(project);
    if (path.includes('\0') || path.split(/[\\/]/).includes('.bin')) throw new Error('无法访问此工作区路径');
    const opened = await openContained(project.local_path, path || '.', { directory, followLinks });
    if (relative(await realpath(project.local_path), opened.actualPath).split(sep).includes('.bin')) {
      await opened.handle.close();
      throw new Error('无法访问运行时内部文件');
    }
    return opened;
  }

  private assertMountable(path: string): void {
    if (this.execution.kind !== 'vm') return;
    const within = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}${sep}`);
    const exposed = (this.config.protectedPaths ?? []).find(item => within(path, item) || within(item, path));
    if (exposed) throw new Error(`本机项目目录不能包含或位于 ${exposed}：项目目录会挂载进虚拟机，其中运行的智能体将能读取这些内容`);
  }

  private async checkLocalDirectory(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    const actual = await realpath(project.local_path);
    this.assertMountable(actual);
    if (actual !== project.local_path || !(await stat(actual)).isDirectory()) throw new Error('本机项目目录已改变或不再可用');
    await access(actual, constants.R_OK | constants.W_OK | constants.X_OK);
  }

  async stat(project: WorkspaceProject, path: string): Promise<ClientStatResult> {
    this.validate(project);
    if (this.isClientDirect(project)) return this.client!.adapter.stat(project.dev_host_id, project.remote_path, path);
    const meta = await lstat(resolve(project.local_path, path || '.')).catch(() => undefined);
    if (!meta) return { exists: false };
    return { exists: true, kind: meta.isSymbolicLink() ? 'symlink' : meta.isDirectory() ? 'directory' : 'file', size: meta.size, mtimeMs: meta.mtimeMs, isSymlink: meta.isSymbolicLink() };
  }

  async readSlice(project: WorkspaceProject, path: string, maxBytes: number) {
    this.validate(project);
    if (!this.isClientDirect(project)) throw new Error('仅客户端直连模式使用 readSlice');
    return this.client!.adapter.readSlice(project.dev_host_id, project.remote_path, path, 0, maxBytes);
  }

  async files(project: WorkspaceProject, path = '', { followLinks = true } = {}) {
    if (this.isClientDirect(project)) { this.validate(project); return this.client!.adapter.listFiles(project.dev_host_id, project.remote_path, path); }
    const { handle, actualPath } = await this.openProjectPath(project, path, true, followLinks);
    try {
      const entries = await readdir(descriptorPath(handle), { withFileTypes: true });
      const visible = entries.filter(entry => !entry.name.startsWith('.bin') && entry.name !== '.git' && !entry.isSymbolicLink());
      const listed = await Promise.all(visible.map(async entry => {
        const type = entry.isDirectory() ? 'directory' as const : 'file' as const;
        const size = type === 'file' ? await lstat(join(actualPath, entry.name)).then(metadata => metadata.size, () => undefined) : undefined;
        return { name: entry.name, path: [path.replace(/\/$/, ''), entry.name].filter(Boolean).join('/'), type, size };
      }));
      return { path, entries: listed.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1)) };
    } finally { await handle.close(); }
  }

  async file(project: WorkspaceProject, path: string): Promise<{ path: string; size: number; mtime: number; binary: boolean; content?: string }> {
    if (this.isClientDirect(project)) { this.validate(project); return this.client!.adapter.readFile(project.dev_host_id, project.remote_path, path); }
    const { handle, size, mtime } = await this.openProjectPath(project, path, false, true);
    try {
      if (size > 1024 * 1024) return { path, size, mtime, binary: true };
      const content = await handle.readFile();
      if (content.includes(0)) return { path, size, mtime, binary: true };
      return { path, size, mtime, binary: false, content: content.toString('utf8') };
    } finally { await handle.close(); }
  }

  /** The caller owns the returned handle and must close it. */
  rawFile(project: WorkspaceProject, path: string, { followLinks = true } = {}): Promise<WorkspaceRawFile> {
    if (this.isClientDirect(project)) { this.validate(project); return this.client!.adapter.openRawFile(project.dev_host_id, project.remote_path, path); }
    return this.openProjectPath(project, path, false, followLinks);
  }

  async writableDirectory(project: WorkspaceProject, segments: string[], create: boolean): Promise<ContainedFile> {
    this.validate(project);
    if (this.isClientDirect(project)) throw new Error('客户端直连模式不支持本地目录写入');
    if (project.execution_mode === 'local') await this.checkLocalDirectory(project);
    if (segments.includes('.bin')) throw new Error('无法访问运行时内部文件');
    return openContainedDirectory(project.local_path, segments, create);
  }

  async git(userId: string, host: DevHost, project: WorkspaceProject): Promise<{ branch: string; status: string; diff: string }> {
    this.validate(project);
    assertHostOwner(userId, host);
    if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
    if (host.kind === 'client') {
      if (!this.client) throw new Error('客户端工作区服务未就绪');
      if (project.client_mode === 'mirrored') await this.flush(project);
      return this.client.adapter.gitStatus(host.id, project.remote_path);
    }
    if ((host.kind === 'local') !== (project.execution_mode === 'local')) throw new Error('本机项目与开发机类型不匹配');
    if (project.execution_mode !== 'local') assertSshHost(host);
    await this.flush(project);
    const command = "git rev-parse --abbrev-ref HEAD && printf '\\0' && git status --short && printf '\\0' && git diff --no-ext-diff --no-color HEAD -- .";
    const result = project.execution_mode === 'local'
      ? await this.execution.run('/bin/bash', ['-c', command], { scope: this.scope(project), cwd: project.local_path, env: { GIT_OPTIONAL_LOCKS: '0' } })
      : await this.ssh.exec(userId, host, remoteCommand(project, command));
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取 Git 状态，请确认目录为 Git 仓库');
    const [branch = '', status = '', diff = ''] = result.stdout.split('\0');
    return { branch: branch.trim(), status, diff };
  }
}

async function diskUsage(paths: string[]): Promise<number> {
  const existing = (await Promise.all(paths.map(path => lstat(path).then(() => path, () => undefined))))
    .filter((path): path is string => !!path);
  if (!existing.length) return 0;
  const result = await runCommand('du', ['-skc', '--', ...existing], { timeout: 60_000, env: childEnvironment({ LC_ALL: 'C' }) });
  const total = /^(\d+)\s+total$/m.exec(result.stdout.trim().split('\n').at(-1) ?? '');
  if (!total) throw new Error(result.stderr.trim() || '无法统计工作区磁盘占用');
  return Number(total[1]) * 1024;
}
