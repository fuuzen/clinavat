import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, checkedCommand } from './process.js';
import { renderRemoteShell } from './remote-shell.js';
import { SshManager } from './ssh.js';
import { assertHostOwner, assertIdentifier, assertRemotePath, shellQuote, type DevHost, type RuntimeConfig, type WorkspaceProject } from './types.js';

const IGNORES = [
  'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.nuxt',
  '.cache', 'coverage', '/.bin', '*.log', '*.pyc', '*.o', '*.so', '*.a', '*.zip', '*.tar', '*.gz',
  '*.mp4', '*.mov', '*.iso', '*.sqlite', '*.db',
];

export class WorkspaceManager {
  private readonly initializations = new Map<string, Promise<void>>();

  constructor(readonly config: RuntimeConfig, readonly ssh: SshManager) {}

  private validate(project: WorkspaceProject): void {
    assertIdentifier(project.id);
    assertIdentifier(project.user_id);
    assertIdentifier(project.dev_host_id);
    assertIdentifier(project.sync_name);
    assertRemotePath(project.remote_path);
    const workspaceRoot = resolve(this.config.dataDir, 'workspaces');
    const child = relative(workspaceRoot, resolve(project.local_path));
    if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('工作区路径不在受管理的目录内');
  }

  private async mutagen(project: WorkspaceProject, args: string[], timeout = 60_000) {
    this.validate(project);
    return checkedCommand(this.config.mutagenBinary ?? 'mutagen', args, {
      env: await this.ssh.mutagenEnvironment(project.user_id), timeout,
    });
  }

  async create(userId: string, host: DevHost, project: WorkspaceProject): Promise<void> {
    const existing = this.initializations.get(project.id);
    if (existing) return existing;
    const task = this.initialize(userId, host, project);
    this.initializations.set(project.id, task);
    try { await task; } finally { this.initializations.delete(project.id); }
  }

  private missingSession(error: unknown, project: WorkspaceProject): boolean {
    return error instanceof Error && error.message.includes(`specification "${project.sync_name}" did not match any sessions`);
  }

  private async sessionExists(project: WorkspaceProject): Promise<boolean> {
    try { await this.mutagen(project, ['sync', 'list', project.sync_name]); return true; }
    catch (error) {
      if (this.missingSession(error, project)) return false;
      throw error;
    }
  }

  private async initialize(userId: string, host: DevHost, project: WorkspaceProject): Promise<void> {
    this.validate(project);
    assertHostOwner(userId, host);
    if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
    await this.ssh.addHost(userId, host);
    const exists = await this.ssh.exec(userId, host, `test -d ${shellQuote(project.remote_path)}`);
    if (exists.code !== 0) throw new Error(exists.stderr.trim() || '远端工程目录不存在或不可访问');
    await mkdir(project.local_path, {recursive: true, mode: 0o700});
    const environment = await this.ssh.mutagenEnvironment(userId);
    const binDirectory = join(project.local_path, '.bin');
    await mkdir(binDirectory, {recursive: true, mode: 0o700});
    const script = join(binDirectory, 'remote-shell');
    await atomicWrite(script, renderRemoteShell(this.config, project, this.ssh.configPath(userId), this.ssh.alias(host), environment), 0o500);
    if (await this.sessionExists(project)) {
      await this.mutagen(project, ['sync', 'resume', project.sync_name]);
      await this.flush(project);
      return;
    }
    let created = false;
    try {
      await this.mutagen(project, [
        'sync', 'create', '--name', project.sync_name, '--sync-mode', 'two-way-resolved',
        '--no-global-configuration', '--ignore-vcs',
        ...IGNORES.flatMap(pattern => ['--ignore', pattern]),
        `${this.ssh.alias(host)}:${project.remote_path}`, project.local_path,
      ], 120_000);
      created = true;
      await this.flush(project);
    } catch (error) {
      if (created) await this.mutagen(project, ['sync', 'terminate', project.sync_name], 15_000).catch(() => undefined);
      throw error;
    }
  }

  async flush(project: WorkspaceProject): Promise<void> {
    await this.mutagen(project, ['sync', 'flush', project.sync_name], 120_000);
  }

  async pause(project: WorkspaceProject): Promise<void> {
    try { await this.mutagen(project, ['sync', 'pause', project.sync_name]); }
    catch (error) { if (!this.missingSession(error, project)) throw error; }
  }

  async status(project: WorkspaceProject): Promise<{status: string; detail: string}> {
    const result = await this.mutagen(project, ['sync', 'list', project.sync_name]);
    const statusLine = result.stdout.match(/^Status:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const status = /watching for changes/i.test(statusLine) ? 'WATCHING'
      : /paused/i.test(statusLine) ? 'PAUSED'
      : /disconnected|error|unable|halted/i.test(result.stdout) ? 'ERROR' : 'SYNCING';
    return {status, detail: result.stdout.trim()};
  }

  async remove(project: WorkspaceProject): Promise<void> {
    this.validate(project);
    // Stop propagation before deleting the local mirror; reversing this order could delete remote source files.
    try { await this.mutagen(project, ['sync', 'terminate', project.sync_name]); }
    catch (error) { if (!this.missingSession(error, project)) throw error; }
    await rm(project.local_path, {recursive: true, force: true});
  }

  private async safePath(project: WorkspaceProject, path: string): Promise<string> {
    this.validate(project);
    if (path.includes('\0') || path.split(/[\\/]/).includes('.bin')) throw new Error('无法访问此工作区路径');
    const root = await realpath(project.local_path);
    const target = await realpath(resolve(root, path || '.'));
    const child = relative(root, target);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('路径超出工作区范围');
    if (child.split(sep).includes('.bin')) throw new Error('无法访问运行时内部文件');
    return target;
  }

  async files(project: WorkspaceProject, path = '') {
    const target = await this.safePath(project, path);
    const entries = await readdir(target, {withFileTypes: true});
    const visible = entries.filter(entry => !entry.name.startsWith('.bin') && entry.name !== '.git' && !entry.isSymbolicLink());
    return {path, entries: visible.map(entry => ({
      name: entry.name, path: [path.replace(/\/$/, ''), entry.name].filter(Boolean).join('/'),
      type: entry.isDirectory() ? 'directory' as const : 'file' as const,
    })).sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1))};
  }

  async file(project: WorkspaceProject, path: string): Promise<{path: string; content: string}> {
    const target = await this.safePath(project, path);
    const metadata = await lstat(target);
    if (!metadata.isFile()) throw new Error('只能预览普通文件');
    if (metadata.size > 1024 * 1024) throw new Error('文件超过 1 MiB，无法在线预览');
    const content = await readFile(target);
    if (content.includes(0)) throw new Error('暂不支持预览二进制文件');
    return {path, content: content.toString('utf8')};
  }

  async git(userId: string, host: DevHost, project: WorkspaceProject): Promise<{branch: string; status: string; diff: string}> {
    this.validate(project);
    if (project.user_id !== userId || project.dev_host_id !== host.id) throw new Error('工作区归属不匹配');
    await this.flush(project);
    const prefix = `cd -- ${shellQuote(project.remote_path)} && `;
    const result = await this.ssh.exec(userId, host, prefix + "git rev-parse --abbrev-ref HEAD && printf '\\0' && git status --short && printf '\\0' && git diff --no-ext-diff --no-color HEAD -- .");
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取 Git 状态，请确认目录为 Git 仓库');
    const [branch = '', status = '', diff = ''] = result.stdout.split('\0');
    return {branch: branch.trim(), status, diff};
  }
}
