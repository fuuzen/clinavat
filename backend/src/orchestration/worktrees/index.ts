import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertClientPath, normalizeRelativePath, vmTargetPath } from '../../client-host/path-utils.js';
import type { Context } from '../../context.js';
import { HttpError, type Project, type Session } from '../../models.js';
import type { CommitContext } from './commit-message.js';
import {
  execGitShell,
  hostForProject,
  isClientProject,
  runGitShell,
  shellQuote,
  type ClientCreateResult,
  type ClientInspectResult,
} from './git-shell.js';
import { mergeWorktree, type MergeOutcome } from './merge.js';
import { settleWorktree, type SettleDeps } from './settle.js';

export { buildCommitMessage, normalizeCommitMessage } from './commit-message.js';
export type { BuildCommitMessageOptions, ChangedFileEntry, CommitContext, CommitTaskContext } from './commit-message.js';
export type { MergeOutcome } from './merge.js';

const posix = path.posix;
const syncTimeout = 30 * 60_000;
const setupTimeout = 10 * 60_000;

const inside = (root: string, target: string) => {
  const relative = posix.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative));
};

/** Child agents' Git worktrees: one checkout and branch each, as a project of its own under the master's project. */
export class WorktreeManager {
  constructor(private readonly context: Context) {}

  private deps(): SettleDeps {
    return {
      context: this.context,
      getProject: id => this.project(id),
      quiesce: child => this.quiesce(child),
      release: project => this.release(project),
    };
  }

  /** The repository holding the directory, with real paths; undefined unless the directory is tracked in a commit there. */
  async repository(project: Project, directory: string | null) {
    if (isClientProject(this.context, project)) {
      const platform = this.context.workspaces.clientPlatform(project.dev_host_id);
      const result = await this.context.clientWorkspaceAdapter.gitWorktree<ClientInspectResult>(project.dev_host_id, {
        op: 'inspect', root: project.remote_path, ...(directory ? { directory } : {}),
      });
      if (!result?.isRepo || !result.repo || !result.head) return undefined;
      const root = assertClientPath(platform, result.root ?? project.remote_path);
      const repo = assertClientPath(platform, result.repo);
      const target = assertClientPath(platform, result.target ?? root);
      return { root, target, repo, head: result.head, dirty: Boolean(result.dirty) };
    }
    const target = posix.join(project.remote_path, directory ?? '');
    const output = await runGitShell(this.context, project, `cd -- ${shellQuote(target)}
root=$(cd -- ${shellQuote(project.remote_path)} && pwd -P)
top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf none; exit 0; }
head=$(git rev-parse --verify -q HEAD) || { printf none; exit 0; }
inside=$(git rev-parse --show-prefix)
if [ -n "$inside" ] && ! git cat-file -e "HEAD:$inside" 2>/dev/null; then printf none; exit 0; fi
dirty=$(git -C "$top" status --porcelain --untracked-files=no 2>/dev/null | head -c 1 || true)
printf 'repo\\0%s\\0%s\\0%s\\0%s\\0%s' "$root" "$(pwd -P)" "$top" "$head" "$dirty"`);
    const [kind, root, target_, repo, head, dirty] = output.split('\0');
    return kind === 'repo' ? { root, target: target_, repo, head, dirty: !!dirty } : undefined;
  }

  private async checkout(main: Project, repo: string, head: string, destination: string, branch: string): Promise<string> {
    const local = main.execution_mode === 'local';
    return (await runGitShell(this.context, main, `repo=${shellQuote(repo)}; dest=${destination}
mkdir -p -- "$(dirname -- "$dest")"
if [ -e "$dest" ]; then git -C "$repo" worktree remove --force "$dest" >/dev/null 2>&1 || rm -rf -- "$dest"; fi
git -C "$repo" worktree prune
git -C "$repo" -c core.hooksPath=/dev/null worktree add -q -b ${shellQuote(branch)} "$dest" ${shellQuote(head)} >&2
${local ? `common=$(cd -- "$repo" && cd -- "$(git rev-parse --git-common-dir)" && pwd -P)
mkdir -p -- "$common/info"; grep -qxF '.clinavat/' "$common/info/exclude" 2>/dev/null || printf '.clinavat/\\n' >> "$common/info/exclude"` : ''}
if [ -f "$repo/.worktreeinclude" ]; then
  (cd -- "$repo" && git ls-files -z --others --ignored --exclude-from=.worktreeinclude | tar --null -T - -cf -) | tar -xf - -C "$dest"
fi
cd -- "$dest" && pwd -P`, 300_000)).trim();
  }

  /** Sets up the child's worktree project; undefined when the directory is in no repository with commits. */
  async create(main: Project, master: Session, name: string, directory: string | null) {
    const found = await this.repository(main, directory);
    if (!found) return undefined;
    const branch = `clinavat/${master.id.slice(0, 8)}/${name}-${randomBytes(2).toString('hex')}`;
    const isClient = isClientProject(this.context, main);
    const local = main.execution_mode === 'local';
    let worktree: string;
    let projectRoot: string;
    let childDirectory: string | null;

    if (isClient) {
      const platform = this.context.workspaces.clientPlatform(main.dev_host_id);
      const created = await this.context.clientWorkspaceAdapter.gitWorktree<ClientCreateResult>(main.dev_host_id, {
        op: 'create', repo: found.repo, root: found.root, head: found.head, branch,
        target: found.target, ...(directory ? { directory } : {}),
        worktreeName: `${master.id.slice(0, 8)}-${name}`, mainProjectId: main.id,
      });
      worktree = assertClientPath(platform, created.worktreePath);
      projectRoot = created.projectRoot !== undefined ? assertClientPath(platform, created.projectRoot) : worktree;
      const rawChildDir = created.childDirectory !== undefined ? created.childDirectory : directory;
      if (rawChildDir !== null && rawChildDir !== undefined && rawChildDir !== '') {
        if (typeof rawChildDir !== 'string' || /^[A-Za-z]:/.test(rawChildDir)) {
          throw new Error(`客户端返回的子目录路径无效：${String(rawChildDir)}`);
        }
        childDirectory = normalizeRelativePath(rawChildDir);
      } else {
        childDirectory = null;
      }
    } else {
      const destination = local
        ? shellQuote(posix.join(found.root, '.clinavat', 'worktrees', `${master.id.slice(0, 8)}-${name}`))
        : `"$HOME"/.clinavat/worktrees/${shellQuote(main.id)}/${shellQuote(`${master.id.slice(0, 8)}-${name}`)}`;
      worktree = await this.checkout(main, found.repo, found.head, destination, branch);
      projectRoot = inside(found.repo, found.root) ? posix.join(worktree, posix.relative(found.repo, found.root)) : worktree;
      childDirectory = (inside(found.repo, found.root) ? posix.relative(found.root, found.target) : posix.relative(found.repo, found.target)) || null;
    }

    const id = randomUUID();
    const clientMode = isClient ? (main.client_mode ?? 'direct') : 'direct';
    const localPath = local ? projectRoot : posix.join(this.context.config.workspaceDir, `proj_${id}`);
    const vmPath = isClient && clientMode === 'mirrored'
      ? vmTargetPath(this.context.workspaces.clientPlatform(main.dev_host_id), projectRoot, localPath,
        [this.context.config.dataDir, this.context.config.workspaceDir])
      : null;
    const initialSyncStatus = local ? 'LOCAL' : (isClient && clientMode === 'direct') ? 'READY' : 'CREATING';
    const project: Project = {
      ...main, id, name: `${main.name} · ${name}`, remote_path: projectRoot, sync_name: `proj-${id}`,
      local_path: localPath, execution_mode: local ? 'local' : null,
      client_mode: clientMode, vm_path: vmPath,
      sync_status: initialSyncStatus, created_at: new Date().toISOString(), sync_rules: main.sync_rules ?? '',
      parent_project_id: main.id, worktree_repo: found.repo, worktree_path: worktree, worktree_branch: branch, worktree_base: found.head,
      worktree_state: null, worktree_setup: null, sync_skipped_links: null,
    };
    this.context.store.run(`INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name,sync_status,path_mode,execution_mode,
      client_mode,vm_path,sync_rules,parent_project_id,worktree_repo,worktree_path,worktree_branch,worktree_base)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, project.user_id, project.dev_host_id, project.name, project.remote_path, project.local_path, project.sync_name, project.sync_status,
    project.path_mode, local ? 'local' : null, clientMode, vmPath, project.sync_rules, main.id, found.repo, worktree, branch, found.head);
    try { await this.prepare(main, project); }
    catch (error) {
      await this.release(project).catch(() => undefined);
      this.context.store.run('DELETE FROM projects WHERE id=?', id);
      throw error;
    }
    const setup = await this.setup(main, project);
    return { project: this.project(id), directory: childDirectory || null, dirty: found.dirty, setup };
  }

  /** Brings a cleaned-up worktree back for a new task, at the same path so the CLI finds its native session again. */
  async revive(project: Project): Promise<Project> {
    const main = this.project(project.parent_project_id!);
    const isClient = isClientProject(this.context, main);
    let head: string;
    const branch = `${project.worktree_branch!.replace(/-[0-9a-f]{4}$/, '')}-${randomBytes(2).toString('hex')}`;
    if (isClient) {
      const inspected = await this.context.clientWorkspaceAdapter.gitWorktree<ClientInspectResult>(main.dev_host_id, {
        op: 'inspect', root: project.worktree_repo!,
      });
      if (!inspected?.isRepo || !inspected.head) throw new HttpError(409, `子智能体的仓库 ${project.worktree_repo} 已不存在或没有提交`);
      head = inspected.head;
      await this.context.clientWorkspaceAdapter.gitWorktree(main.dev_host_id, {
        op: 'create', repo: project.worktree_repo!, root: main.remote_path, head, branch, destination: project.worktree_path!,
      });
    } else {
      head = (await execGitShell(this.context, main, `git -C ${shellQuote(project.worktree_repo!)} rev-parse --verify -q HEAD`)).stdout.trim();
      if (!head) throw new HttpError(409, `子智能体的仓库 ${project.worktree_repo} 已不存在或没有提交`);
      await this.checkout(main, project.worktree_repo!, head, shellQuote(project.worktree_path!), branch);
    }
    const nextStatus = project.execution_mode === 'local' ? 'LOCAL' : (isClient && project.client_mode !== 'mirrored') ? 'READY' : 'CREATING';
    this.context.store.run('UPDATE projects SET worktree_branch=?,worktree_base=?,worktree_state=NULL,sync_status=? WHERE id=?',
      branch, head, nextStatus, project.id);
    await this.prepare(main, this.project(project.id));
    await this.setup(main, this.project(project.id));
    return this.project(project.id);
  }

  private async prepare(main: Project, project: Project): Promise<void> {
    const host = hostForProject(this.context, main);
    await this.context.workspaces.create(project.user_id, host, project, syncTimeout);
    const readyStatus = project.execution_mode === 'local' ? 'LOCAL'
      : (host.kind === 'client' && project.client_mode !== 'mirrored') ? 'READY' : 'WATCHING';
    this.context.store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?',
      readyStatus, project.execution_mode, project.id);
    this.context.events.emit(project.user_id, { type: 'project', payload: this.project(project.id) });
  }

  private async setup(main: Project, project: Project): Promise<string | undefined> {
    if (!main.worktree_setup?.trim()) return undefined;
    if (isClientProject(this.context, main)) {
      const result = await this.context.clientWorkspaceAdapter.execCommand(main.dev_host_id, {
        cwd: project.remote_path, command: main.worktree_setup, waitMs: setupTimeout,
      }, setupTimeout).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
      return result.exitCode === 0 ? undefined : `初始化命令失败：${(result.stderr || result.stdout).trim().slice(-1000)}`;
    }
    const result = await execGitShell(this.context, main, `cd -- ${shellQuote(project.remote_path)}\nbash -lc ${shellQuote(main.worktree_setup)}`, setupTimeout)
      .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    return result.code === 0 ? undefined : `初始化命令失败：${(result.stderr || result.stdout).trim().slice(-1000)}`;
  }

  async settle(child: Session, commitContext?: CommitContext): Promise<string> {
    return (await settleWorktree(this.deps(), child, commitContext)).summary;
  }

  async merge(child: Session, mode: 'merge' | 'squash', onConflict: 'abort' | 'leave', commitContext?: CommitContext): Promise<MergeOutcome> {
    return mergeWorktree(this.deps(), child, mode, onConflict, commitContext);
  }

  async release(project: Project): Promise<void> {
    if (!project.worktree_path || !project.parent_project_id) return;
    await this.context.workspaces.remove(project);
    const main = this.project(project.parent_project_id);
    if (isClientProject(this.context, main)) {
      await this.context.clientWorkspaceAdapter.gitWorktree(main.dev_host_id, {
        op: 'remove', repo: project.worktree_repo!, worktreePath: project.worktree_path, branch: project.worktree_branch!,
      });
      return;
    }
    await runGitShell(this.context, main, `repo=${shellQuote(project.worktree_repo!)}
git -C "$repo" worktree remove --force ${shellQuote(project.worktree_path)} >/dev/null 2>&1 || rm -rf -- ${shellQuote(project.worktree_path)}
git -C "$repo" worktree prune
git -C "$repo" branch -D ${shellQuote(project.worktree_branch!)} >/dev/null 2>&1 || true`);
  }

  async discard(child: Session): Promise<void> {
    if (!await this.quiesce(child)) throw new HttpError(409, `子智能体 ${child.agent_name} 仍在运行，请先停止它`);
    const project = this.project(child.project_id);
    if (project.sync_status !== 'DORMANT') await this.release(project);
    this.context.store.run("UPDATE projects SET sync_status='DORMANT',worktree_state=NULL,worktree_conflicts=NULL WHERE id=?", project.id);
  }

  private async quiesce(child: Session): Promise<boolean> {
    await this.context.agents.reclaim(child.id);
    return !this.context.agents.isBusy(child.id);
  }

  project(id: string): Project {
    const project = this.context.store.get<Project>('SELECT * FROM projects WHERE id=?', id);
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  }
}

export { WorktreeManager as Worktrees };
