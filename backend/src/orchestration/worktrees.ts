import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { hostFor, type Context } from '../context.js';
import { HttpError, type Project, type Session } from '../models.js';
import { runCommand } from '../runtime/process.js';
import { shellQuote } from '../runtime/types.js';

const posix = path.posix;
const syncTimeout = 30 * 60_000;
const setupTimeout = 10 * 60_000;

// The Hub makes these commits, so repository hooks never run, and a repository without an identity gets a neutral one.
const gitIdentity = 'if ! git config user.email >/dev/null 2>&1; then export GIT_AUTHOR_NAME=Clinavat GIT_AUTHOR_EMAIL=clinavat@localhost GIT_COMMITTER_NAME=Clinavat GIT_COMMITTER_EMAIL=clinavat@localhost; fi';

const inside = (root: string, target: string) => {
  const relative = posix.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative));
};

export interface MergeOutcome { status: 'merged' | 'conflict' | 'failed'; files: string[]; detail: string }

/** Child agents' Git worktrees: one checkout and branch each, as a project of its own under the master's project. */
export class Worktrees {
  constructor(private readonly context: Context) {}

  /** Runs Bash where the project's files are: on its development host, or on this machine for a local project. */
  private async shell(project: Project, script: string, timeout = 120_000) {
    const body = `set -eu\n${script}`;
    return project.execution_mode === 'local'
      ? runCommand('bash', ['-c', body], { timeout, maxBytes: 1024 * 1024 })
      : this.context.ssh.exec(project.user_id, hostFor(this.context, project.dev_host_id, project.user_id), body, timeout, 1024 * 1024);
  }

  private async run(project: Project, script: string, timeout?: number): Promise<string> {
    const result = await this.shell(project, script, timeout);
    if (result.code !== 0) throw new Error(`Git 操作失败：${(result.stderr || result.stdout).trim().slice(-2000) || `退出码 ${result.code}`}`);
    return result.stdout;
  }

  /** The repository holding the directory, with real paths; undefined unless the directory is tracked in a commit there. */
  async repository(project: Project, directory: string | null) {
    const target = posix.join(project.remote_path, directory ?? '');
    const output = await this.run(project, `cd -- ${shellQuote(target)}
root=$(cd -- ${shellQuote(project.remote_path)} && pwd -P)
top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf none; exit 0; }
head=$(git rev-parse --verify -q HEAD) || { printf none; exit 0; }
# A checkout has only what HEAD tracks: a directory the repository ignores or never committed would not be there.
inside=$(git rev-parse --show-prefix)
if [ -n "$inside" ] && ! git cat-file -e "HEAD:$inside" 2>/dev/null; then printf none; exit 0; fi
dirty=$(git -C "$top" status --porcelain --untracked-files=no 2>/dev/null | head -c 1 || true)
printf 'repo\\0%s\\0%s\\0%s\\0%s\\0%s' "$root" "$(pwd -P)" "$top" "$head" "$dirty"`);
    const [kind, root, target_, repo, head, dirty] = output.split('\0');
    return kind === 'repo' ? { root, target: target_, repo, head, dirty: !!dirty } : undefined;
  }

  /** Checks out a new branch at the repository's HEAD into the worktree path, replacing what an earlier one left. */
  private async checkout(main: Project, repo: string, head: string, destination: string, branch: string): Promise<string> {
    const local = main.execution_mode === 'local';
    return (await this.run(main, `repo=${shellQuote(repo)}; dest=${destination}
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
    // Local projects keep it inside their root, which the slot machines may mount; elsewhere the master's sync would copy it.
    const destination = main.execution_mode === 'local'
      ? shellQuote(posix.join(found.root, '.clinavat', 'worktrees', `${master.id.slice(0, 8)}-${name}`))
      : `"$HOME"/.clinavat/worktrees/${shellQuote(main.id)}/${shellQuote(`${master.id.slice(0, 8)}-${name}`)}`;
    const worktree = await this.checkout(main, found.repo, found.head, destination, branch);
    // The child sees the same part of the repository as the master's project, and works where the master asked.
    const projectRoot = inside(found.repo, found.root) ? posix.join(worktree, posix.relative(found.repo, found.root)) : worktree;
    const childDirectory = inside(found.repo, found.root) ? posix.relative(found.root, found.target) : posix.relative(found.repo, found.target);
    const id = randomUUID();
    const local = main.execution_mode === 'local';
    const project: Project = {
      ...main, id, name: `${main.name} · ${name}`, remote_path: projectRoot, sync_name: `proj-${id}`,
      local_path: local ? projectRoot : posix.join(this.context.config.workspaceDir, `proj_${id}`), execution_mode: local ? 'local' : null,
      sync_status: local ? 'LOCAL' : 'CREATING', created_at: new Date().toISOString(), sync_rules: main.sync_rules ?? '',
      parent_project_id: main.id, worktree_repo: found.repo, worktree_path: worktree, worktree_branch: branch, worktree_base: found.head,
      worktree_state: null, worktree_setup: null, sync_skipped_links: null,
    };
    this.context.store.run(`INSERT INTO projects(id,user_id,dev_host_id,name,remote_path,local_path,sync_name,sync_status,path_mode,execution_mode,
      sync_rules,parent_project_id,worktree_repo,worktree_path,worktree_branch,worktree_base) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, project.user_id, project.dev_host_id, project.name, project.remote_path, project.local_path, project.sync_name, project.sync_status,
    project.path_mode, local ? 'local' : null, project.sync_rules, main.id, found.repo, worktree, branch, found.head);
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
    const head = (await this.shell(main, `git -C ${shellQuote(project.worktree_repo!)} rev-parse --verify -q HEAD`)).stdout.trim();
    if (!head) throw new HttpError(409, `子智能体的仓库 ${project.worktree_repo} 已不存在或没有提交`);
    const branch = `${project.worktree_branch!.replace(/-[0-9a-f]{4}$/, '')}-${randomBytes(2).toString('hex')}`;
    await this.checkout(main, project.worktree_repo!, head, shellQuote(project.worktree_path!), branch);
    this.context.store.run(`UPDATE projects SET worktree_branch=?,worktree_base=?,worktree_state=NULL,sync_status=? WHERE id=?`,
      branch, head, project.execution_mode === 'local' ? 'LOCAL' : 'CREATING', project.id);
    await this.prepare(main, this.project(project.id));
    await this.setup(main, this.project(project.id));
    return this.project(project.id);
  }

  private async prepare(main: Project, project: Project): Promise<void> {
    const host = hostFor(this.context, main.dev_host_id, main.user_id);
    await this.context.workspaces.create(project.user_id, host, project, syncTimeout);
    this.context.store.run('UPDATE projects SET sync_status=?,execution_mode=? WHERE id=?',
      project.execution_mode === 'local' ? 'LOCAL' : 'WATCHING', project.execution_mode, project.id);
    this.context.events.emit(project.user_id, { type: 'project', payload: this.project(project.id) });
  }

  /** The user's own setup command of the master project; a failure is reported, not fatal. */
  private async setup(main: Project, project: Project): Promise<string | undefined> {
    if (!main.worktree_setup?.trim()) return undefined;
    const result = await this.shell(main, `cd -- ${shellQuote(project.remote_path)}\nbash -lc ${shellQuote(main.worktree_setup)}`, setupTimeout)
      .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    return result.code === 0 ? undefined : `初始化命令失败：${(result.stderr || result.stdout).trim().slice(-1000)}`;
  }

  /**
   * After a task: commits what the child left uncommitted to its branch, then either cleans an unchanged worktree up or
   * describes the branch for the report.
   */
  async settle(child: Session): Promise<string> {
    const project = this.project(child.project_id);
    if (!project.worktree_path || !['WATCHING', 'LOCAL'].includes(project.sync_status)) return '';
    await this.context.workspaces.flush(project);
    const output = await this.run(project, `cd -- ${shellQuote(project.worktree_path)}
${gitIdentity}
if [ -n "$(git status --porcelain)" ]; then git add -A && git -c core.hooksPath=/dev/null commit -q --no-verify -m ${shellQuote(`clinavat: ${child.agent_name} 的修改`)}; fi
printf '%s\\0' "$(git rev-list --count ${shellQuote(project.worktree_base!)}..HEAD)"
git diff --stat ${shellQuote(project.worktree_base!)}..HEAD | tail -n 40`);
    const [count, stat] = output.split('\0');
    if (Number(count) === 0) {
      if (!await this.quiesce(child)) {
        this.context.store.run("UPDATE projects SET worktree_state=NULL WHERE id=?", project.id);
        return '';
      }
      await this.release(project);
      this.context.store.run("UPDATE projects SET sync_status='DORMANT',worktree_state=NULL WHERE id=?", project.id);
      return '[worktree] 没有修改文件，worktree 和分支已清理；再发消息时会从最新的提交重新创建。';
    }
    this.context.store.run("UPDATE projects SET worktree_state='changes' WHERE id=?", project.id);
    return `[worktree] 修改已提交到分支 ${project.worktree_branch}（${count} 个提交，基于 ${project.worktree_base!.slice(0, 10)}）：\n${stat.trim()}\n用 merge_agent 合并到主目录，或用 discard_agent 丢弃。`;
  }

  /** Merges the child's branch into the master's checkout; on conflict it stops unless asked to leave the conflict there. */
  async merge(child: Session, mode: 'merge' | 'squash', onConflict: 'abort' | 'leave'): Promise<MergeOutcome> {
    const project = this.project(child.project_id);
    if (project.sync_status === 'DORMANT' || !project.worktree_branch) return { status: 'failed', files: [], detail: '子智能体没有待合并的修改' };
    const settled = await this.settle(child);
    if (this.project(project.id).sync_status === 'DORMANT') return { status: 'failed', files: [], detail: settled };
    const main = this.project(project.parent_project_id!);
    await this.context.workspaces.flush(main);
    const branch = shellQuote(project.worktree_branch);
    const message = shellQuote(`合并子智能体 ${child.agent_name}（${project.worktree_branch}）`);
    const result = await this.shell(main, `cd -- ${shellQuote(project.worktree_repo!)}
${gitIdentity}
if ${mode === 'squash' ? `git -c core.hooksPath=/dev/null merge --squash ${branch} >&2 && git -c core.hooksPath=/dev/null commit -q --no-verify -m ${message}`
    : `git -c core.hooksPath=/dev/null merge --no-ff --no-verify -m ${message} ${branch} >&2`}; then printf 'merged\\0'; git rev-parse HEAD; exit 0; fi
files=$(git diff --name-only --diff-filter=U)
if [ -z "$files" ]; then git merge --abort >/dev/null 2>&1 || true; printf 'failed\\0'; exit 0; fi
${onConflict === 'abort' ? 'git merge --abort >/dev/null 2>&1 || git reset --merge >/dev/null 2>&1 || true\n' : ''}printf 'conflict\\0%s' "$files"`, 300_000);
    const [status, rest = ''] = result.stdout.split('\0');
    if (status === 'merged') {
      await this.context.workspaces.flush(main);
      if (await this.quiesce(child)) await this.release(project);
      else return { status: 'merged', files: [], detail: `已合并到 ${rest.trim().slice(0, 10)}；子智能体仍在运行，worktree 暂时保留。` };
      this.context.store.run("UPDATE projects SET sync_status='DORMANT',worktree_state=NULL,worktree_conflicts=NULL WHERE id=?", project.id);
      return { status: 'merged', files: [], detail: `已合并到 ${rest.trim().slice(0, 10)}，worktree 和分支已清理。` };
    }
    if (status === 'conflict') {
      const files = rest.split('\n').filter(Boolean);
      this.context.store.run('UPDATE projects SET worktree_state=?,worktree_conflicts=? WHERE id=?', onConflict === 'leave' ? 'resolving' : 'conflict',
        JSON.stringify(files), project.id);
      if (onConflict === 'leave') await this.context.workspaces.flush(main);
      return { status: 'conflict', files, detail: onConflict === 'leave'
        ? '冲突已留在主目录中，解决并提交后，用 discard_agent 清理子智能体的分支。' : '合并因冲突中止，主目录保持原样。' };
    }
    return { status: 'failed', files: [], detail: (result.stderr || result.stdout).trim().slice(-2000) || '合并失败' };
  }

  /** Removes the worktree, its branch and its sync; the project row stays for the child conversation. */
  async release(project: Project): Promise<void> {
    if (!project.worktree_path || !project.parent_project_id) return;
    await this.context.workspaces.remove(project);
    const main = this.project(project.parent_project_id);
    await this.run(main, `repo=${shellQuote(project.worktree_repo!)}
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

  /** Ends the child's idle CLI, whose working directory is about to go; false while it still has work. */
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
