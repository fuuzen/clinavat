import type { Project, Session } from '../../models.js';
import { buildCommitMessage, type ChangedFileEntry, type CommitContext } from './commit-message.js';
import {
  execGitShell,
  gitIdentity,
  gitMergeCommand,
  isClientProject,
  parseNameStatus,
  shellQuote,
  type ClientMergeResult,
} from './git-shell.js';
import { settleWorktree, type SettleDeps } from './settle.js';

export interface MergeOutcome {
  status: 'merged' | 'conflict' | 'failed';
  files: string[];
  detail: string;
}

async function branchChangedFiles(deps: SettleDeps, main: Project, project: Project): Promise<ChangedFileEntry[]> {
  const repo = shellQuote(project.worktree_repo!);
  const branch = shellQuote(project.worktree_branch!);
  const base = project.worktree_base ? shellQuote(project.worktree_base) : '';
  const fallback = base ? ` || git -C ${repo} -c core.quotepath=false diff --name-status ${base}..${branch}` : '';
  const result = await execGitShell(
    deps.context,
    main,
    `out=$(git -C ${repo} -c core.quotepath=false diff --name-status HEAD...${branch} 2>/dev/null${fallback} 2>/dev/null || true)\nprintf '%s' "$out"`,
    60_000,
  ).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return result.code === 0 ? parseNameStatus(result.stdout) : [];
}

/** Merges or squashes a child's worktree branch into the main repository with a normalized Conventional Commit message. */
export async function mergeWorktree(
  deps: SettleDeps,
  child: Session,
  mode: 'merge' | 'squash',
  onConflict: 'abort' | 'leave',
  commitContext?: CommitContext,
): Promise<MergeOutcome> {
  const { context, getProject, quiesce, release } = deps;
  const project = getProject(child.project_id);
  if (project.sync_status === 'DORMANT' || !project.worktree_branch) {
    return { status: 'failed', files: [], detail: '子智能体没有待合并的修改' };
  }

  // Keep any explicit merge commitMessage for the merge/squash commit itself, not the intermediate settle commit.
  const settled = await settleWorktree(deps, child, {
    agentName: commitContext?.agentName ?? child.agent_name,
    branch: commitContext?.branch ?? project.worktree_branch,
    task: commitContext?.task,
    report: commitContext?.report,
  });
  if (settled.dormant || getProject(project.id).sync_status === 'DORMANT') {
    return { status: 'failed', files: [], detail: settled.summary };
  }

  const main = getProject(project.parent_project_id!);
  await context.workspaces.flush(main);
  const clientMode = isClientProject(context, main);

  const files = commitContext?.commitMessage?.trim()
    ? []
    : clientMode
      ? settled.changedFiles
      : await branchChangedFiles(deps, main, project);

  const mergeMessage = buildCommitMessage({
    kind: mode === 'squash' ? 'squash' : 'merge',
    agentName: commitContext?.agentName ?? child.agent_name,
    branch: commitContext?.branch ?? project.worktree_branch,
    task: commitContext?.task,
    report: commitContext?.report,
    commitMessage: commitContext?.commitMessage,
    files: files.length ? files : settled.changedFiles,
  });

  let status: string;
  let commit = '';
  let conflictFiles: string[] = [];
  let failureDetail = '';

  if (clientMode) {
    const res = await context.clientWorkspaceAdapter.gitWorktree<ClientMergeResult>(main.dev_host_id, {
      op: 'merge',
      repo: project.worktree_repo!,
      branch: project.worktree_branch,
      mode,
      onConflict,
      message: mergeMessage,
    });
    status = res.status;
    commit = res.commit ?? '';
    conflictFiles = res.files ?? [];
    failureDetail = res.detail ?? '';
  } else {
    const mergeCmd = gitMergeCommand(project.worktree_branch, mode, mergeMessage);
    const result = await execGitShell(context, main, `cd -- ${shellQuote(project.worktree_repo!)}
${gitIdentity}
if ${mergeCmd}; then printf 'merged\\0'; git rev-parse HEAD; exit 0; fi
files=$(git -c core.quotepath=false diff --name-only --diff-filter=U)
if [ -z "$files" ]; then git merge --abort >/dev/null 2>&1 || true; printf 'failed\\0'; exit 0; fi
${onConflict === 'abort' ? 'git merge --abort >/dev/null 2>&1 || git reset --merge >/dev/null 2>&1 || true\n' : ''}printf 'conflict\\0%s' "$files"`, 300_000);
    const [rawStatus, rest = ''] = result.stdout.split('\0');
    status = rawStatus;
    commit = rest.trim();
    conflictFiles = rest.split('\n').filter(Boolean);
    failureDetail = (result.stderr || result.stdout).trim().slice(-2000);
  }

  if (status === 'merged') {
    await context.workspaces.flush(main);
    if (await quiesce(child)) await release(project);
    else return { status: 'merged', files: [], detail: `已合并到 ${commit.slice(0, 10)}；子智能体仍在运行，worktree 暂时保留。` };
    context.store.run("UPDATE projects SET sync_status='DORMANT',worktree_state=NULL,worktree_conflicts=NULL WHERE id=?", project.id);
    return { status: 'merged', files: [], detail: `已合并到 ${commit.slice(0, 10)}，worktree 和分支已清理。` };
  }
  if (status === 'conflict') {
    context.store.run(
      'UPDATE projects SET worktree_state=?,worktree_conflicts=? WHERE id=?',
      onConflict === 'leave' ? 'resolving' : 'conflict',
      JSON.stringify(conflictFiles),
      project.id,
    );
    if (onConflict === 'leave') await context.workspaces.flush(main);
    return {
      status: 'conflict',
      files: conflictFiles,
      detail: onConflict === 'leave'
        ? '冲突已留在主目录中，解决并提交后，用 discard_agent 清理子智能体的分支。'
        : '合并因冲突中止，主目录保持原样。',
    };
  }
  return { status: 'failed', files: [], detail: failureDetail || '合并失败' };
}
