import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, runCommand } from './process.js';
import { renderRemoteShell } from './remote-shell.js';
import { prepareRemotePath, remoteCommand } from './remote-paths.js';
import { readWorkspaceMigration, saveWorkspaceMigration } from './workspace-migration.js';
import { archiveIgnoredMirror } from './mirror-archive.js';
import { SshManager } from './ssh.js';
import { loadSyncPolicy } from './sync-policy.js';
import { parseSyncStatus, summarizeSyncFailure } from './sync-status.js';
import { assertHostOwner, assertIdentifier, assertRemotePath, type DevHost, type RuntimeConfig, type WorkspaceProject } from './types.js';
import type { ExecutionHost, ExecutionScope } from '../execution/types.js';

export class WorkspaceManager {
  private readonly initializations = new Map<string, Promise<void>>();

  constructor(readonly config: RuntimeConfig, readonly ssh: SshManager, readonly execution: ExecutionHost) {}

  private validate(project: WorkspaceProject): void {
    assertIdentifier(project.id);
    assertIdentifier(project.user_id);
    assertIdentifier(project.dev_host_id);
    assertIdentifier(project.sync_name);
    assertRemotePath(project.remote_path);
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
    if (project.execution_mode === 'local') throw new Error('本机项目不使用文件同步');
    const binary = this.execution.binaries.mutagen;
    const result = await this.execution.run(binary, args, {
      scope: this.scope(project), env: await this.ssh.mutagenEnvironment(project.user_id), timeout,
    });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${binary} 退出码 ${result.code}`).trim().slice(0, 4000));
    return result;
  }

  private scope(project: WorkspaceProject): ExecutionScope {
    return { userId: project.user_id, paths: [project.local_path] };
  }

  async create(userId: string, host: DevHost, project: WorkspaceProject): Promise<void> {
    const existing = this.initializations.get(project.id);
    if (existing) return existing;
    const task = this.initialize(userId, host, project);
    this.initializations.set(project.id, task);
    try { await task; } finally { this.initializations.delete(project.id); }
  }

  async refreshExecutor(project: WorkspaceProject, host: DevHost): Promise<void> {
    this.validate(project);
    assertHostOwner(project.user_id, host);
    if ((host.kind === 'local') !== (project.execution_mode === 'local')) throw new Error('本机项目与开发机类型不匹配');
    if (project.execution_mode === 'local') {
      return;
    }
    const environment = await this.ssh.mutagenEnvironment(project.user_id);
    const binDirectory = join(project.local_path, '.bin');
    await mkdir(binDirectory, {recursive: true, mode: 0o700});
    await atomicWrite(join(binDirectory, 'remote-shell'), renderRemoteShell(this.execution.binaries, project,
      this.ssh.configPath(project.user_id), this.ssh.alias(host), environment), 0o500);
  }

  private missingSession(error: unknown, project: WorkspaceProject): boolean {
    return error instanceof Error && error.message.includes(`specification "${project.sync_name}" did not match any sessions`);
  }

  private async session(project: WorkspaceProject): Promise<{ labels?: Record<string, string> } | undefined> {
    try {
      const result = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}']);
      const sessions = JSON.parse(result.stdout) as { labels?: Record<string, string> }[];
      if (!Array.isArray(sessions) || sessions.length !== 1) throw new Error('无法识别项目同步会话');
      return sessions[0];
    }
    catch (error) {
      if (this.missingSession(error, project)) return undefined;
      throw error;
    }
  }

  private async initialize(userId: string, host: DevHost, project: WorkspaceProject): Promise<void> {
    this.validate(project);
    assertHostOwner(userId, host);
    if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
    if (host.kind === 'local' || project.execution_mode === 'local') {
      if (host.kind !== 'local' || project.execution_mode !== 'local') throw new Error('本机项目与开发机类型不匹配');
      await this.checkLocalDirectory(project);
      return;
    }
    await this.ssh.addHost(userId, host);
    const policy = await loadSyncPolicy(this.config, this.ssh, userId, host, project.remote_path);
    project.execution_mode = await prepareRemotePath(this.config, this.ssh, userId, host, project);
    const session = await this.session(project);
    const migration = await readWorkspaceMigration(this.config, project.id);
    const migratedMirror = !session && migration?.phase === 'complete' && migration.reusable && !migration.restored && migration.newPath === project.local_path;
    const reuse = (session?.labels?.['clinavat-policy'] ?? session?.labels?.['cc-pool-policy']) === policy.fingerprint;
    if (session) {
      await this.mutagen(project, ['sync', 'resume', project.sync_name]);
      if (reuse) await this.flush(project);
      else {
        // Old scan errors may concern newly ignored outputs; require the transfer barrier and retain a full mirror backup.
        await this.flushBarrier(project);
        await this.mutagen(project, ['sync', 'terminate', project.sync_name]);
      }
    }
    if (!reuse && !migratedMirror) {
      const entries = await readdir(project.local_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (entries.some(name => name !== '.bin')) {
        const backupRoot = join(this.config.dataDir, 'backups', 'workspaces');
        await mkdir(backupRoot, { recursive: true, mode: 0o700 });
        await rename(project.local_path, join(backupRoot, `${project.id}-${Date.now()}`));
      }
    }
    if (migratedMirror) {
      const names = await readdir(project.local_path);
      await archiveIgnoredMirror(this.config, project, [
        ...policy.archivePaths,
        ...names.filter(name => (name === '.env' || name.startsWith('.env.')) && !['.env.example', '.env.sample', '.env.template'].includes(name)),
      ]);
    }
    await mkdir(project.local_path, {recursive: true, mode: 0o700});
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
      await this.flush(project);
      if (migration?.reusable) {
        migration.reusable = false;
        await saveWorkspaceMigration(this.config, migration);
      }
    } catch (error) {
      if (created) await this.mutagen(project, ['sync', 'terminate', project.sync_name], 15_000).catch(() => undefined);
      throw error;
    }
  }

  private async flushBarrier(project: WorkspaceProject): Promise<void> {
    try { await this.mutagen(project, ['sync', 'flush', project.sync_name], 120_000); }
    catch (error) {
      const diagnosis = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}'], 10_000)
        .then(result => summarizeSyncFailure(result.stdout)).catch(() => '');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnosis ? `\n${diagnosis}` : ''}`);
    }
  }

  async flush(project: WorkspaceProject): Promise<void> {
    if (project.execution_mode === 'local') { await this.checkLocalDirectory(project); return; }
    await this.flushBarrier(project);
    const health = await this.status(project);
    if (health.status === 'ERROR') throw new Error(`项目同步存在未解决的问题：\n${health.detail}`);
  }

  async pause(project: WorkspaceProject): Promise<void> {
    if (project.execution_mode === 'local') { this.validate(project); return; }
    try { await this.mutagen(project, ['sync', 'pause', project.sync_name]); }
    catch (error) { if (!this.missingSession(error, project)) throw error; }
  }

  async status(project: WorkspaceProject): Promise<{status: string; detail: string}> {
    if (project.execution_mode === 'local') {
      await this.checkLocalDirectory(project);
      return {status: 'LOCAL', detail: '直接使用本机目录，无需同步'};
    }
    const result = await this.mutagen(project, ['sync', 'list', project.sync_name, '--template', '{{json .}}']);
    return parseSyncStatus(result.stdout);
  }

  async remove(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    // Local projects refer to source directories; removing a project never removes its source.
    if (project.execution_mode === 'local') return;
    // Stop propagation before deleting the local mirror; reversing this order could delete remote source files.
    try { await this.mutagen(project, ['sync', 'terminate', project.sync_name]); }
    catch (error) { if (!this.missingSession(error, project)) throw error; }
    await rm(project.local_path, {recursive: true, force: true});
  }

  // Disk usage of the local mirror and of mirror backups kept after rule changes, in bytes.
  async usage(project: WorkspaceProject): Promise<{ mirrorBytes: number | null; backupBytes: number }> {
    this.validate(project);
    if (project.execution_mode === 'local') return { mirrorBytes: null, backupBytes: 0 };
    const backupRoot = join(this.config.dataDir, 'backups', 'workspaces');
    const backups = (await readdir(backupRoot).catch(() => [] as string[]))
      .filter(name => name.startsWith(`${project.id}-`)).map(name => join(backupRoot, name));
    const [mirrorBytes, backupBytes] = await Promise.all([diskUsage([project.local_path]), diskUsage(backups)]);
    return { mirrorBytes, backupBytes };
  }

  private async safePath(project: WorkspaceProject, path: string): Promise<string> {
    this.validate(project);
    if (project.execution_mode === 'local') await this.checkLocalDirectory(project);
    if (path.includes('\0') || path.split(/[\\/]/).includes('.bin')) throw new Error('无法访问此工作区路径');
    const root = await realpath(project.local_path);
    const target = await realpath(resolve(root, path || '.'));
    const child = relative(root, target);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('路径超出工作区范围');
    if (child.split(sep).includes('.bin')) throw new Error('无法访问运行时内部文件');
    return target;
  }

  private async checkLocalDirectory(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    const actual = await realpath(project.local_path);
    if (actual !== project.local_path || !(await stat(actual)).isDirectory()) throw new Error('本机项目目录已改变或不再可用');
    await access(actual, constants.R_OK | constants.W_OK | constants.X_OK);
  }

  async files(project: WorkspaceProject, path = '') {
    const target = await this.safePath(project, path);
    const entries = await readdir(target, {withFileTypes: true});
    const visible = entries.filter(entry => !entry.name.startsWith('.bin') && entry.name !== '.git' && !entry.isSymbolicLink());
    const listed = await Promise.all(visible.map(async entry => {
      const type = entry.isDirectory() ? 'directory' as const : 'file' as const;
      const size = type === 'file' ? await lstat(join(target, entry.name)).then(metadata => metadata.size, () => undefined) : undefined;
      return { name: entry.name, path: [path.replace(/\/$/, ''), entry.name].filter(Boolean).join('/'), type, size };
    }));
    return {path, entries: listed.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1))};
  }

  // Text content is only inlined for small UTF-8 files; anything else is previewed or downloaded through rawFile().
  async file(project: WorkspaceProject, path: string): Promise<{path: string; size: number; mtime: number; binary: boolean; content?: string}> {
    const {target, size, mtime} = await this.rawFile(project, path);
    if (size > 1024 * 1024) return {path, size, mtime, binary: true};
    const content = await readFile(target);
    if (content.includes(0)) return {path, size, mtime, binary: true};
    return {path, size, mtime, binary: false, content: content.toString('utf8')};
  }

  async rawFile(project: WorkspaceProject, path: string): Promise<{target: string; size: number; mtime: number}> {
    const target = await this.safePath(project, path);
    const metadata = await lstat(target);
    if (!metadata.isFile()) throw new Error('只能预览普通文件');
    return {target, size: metadata.size, mtime: Math.floor(metadata.mtimeMs)};
  }

  async git(userId: string, host: DevHost, project: WorkspaceProject): Promise<{branch: string; status: string; diff: string}> {
    this.validate(project);
    assertHostOwner(userId, host);
    if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
    if ((host.kind === 'local') !== (project.execution_mode === 'local')) throw new Error('本机项目与开发机类型不匹配');
    await this.flush(project);
    const command = "git rev-parse --abbrev-ref HEAD && printf '\\0' && git status --short && printf '\\0' && git diff --no-ext-diff --no-color HEAD -- .";
    const result = project.execution_mode === 'local'
      ? await this.execution.run('/bin/bash', ['-c', command], {scope: this.scope(project), cwd: project.local_path})
      : await this.ssh.exec(userId, host, remoteCommand(project, command));
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取 Git 状态，请确认目录为 Git 仓库');
    const [branch = '', status = '', diff = ''] = result.stdout.split('\0');
    return {branch: branch.trim(), status, diff};
  }
}

async function diskUsage(paths: string[]): Promise<number> {
  const existing = (await Promise.all(paths.map(path => lstat(path).then(() => path, () => undefined))))
    .filter((path): path is string => !!path);
  if (!existing.length) return 0;
  // du reports allocated blocks, matching the space the mirror actually consumes.
  const result = await runCommand('du', ['-skc', '--', ...existing], { timeout: 60_000, env: { ...process.env, LC_ALL: 'C' } });
  const total = /^(\d+)\s+total$/m.exec(result.stdout.trim().split('\n').at(-1) ?? '');
  if (!total) throw new Error(result.stderr.trim() || '无法统计工作区磁盘占用');
  return Number(total[1]) * 1024;
}
