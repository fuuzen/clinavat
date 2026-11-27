import type { Context } from '../../context.js';
import type { Project, Session } from '../../models.js';
import { buildCommitMessage, type ChangedFileEntry, type CommitContext } from './commit-message.js';
import {
  clientGitStatusFiles,
  gitCommitCommand,
  gitIdentity,
  isClientProject,
  mergeChangedFiles,
  parseDiffStatPaths,
  parseNameStatus,
  runGitShell,
  shellQuote,
  type ClientCommitResult,
} from './git-shell.js';

export interface SettleDeps {
  context: Context;
  getProject: (id: string) => Project;
  quiesce: (child: Session) => Promise<boolean>;
  release: (project: Project) => Promise<void>;
}

export interface SettleOutcome {
  summary: string;
  commitCount: number;
  diffStat: string;
  changedFiles: ChangedFileEntry[];
  dormant: boolean;
}

/** Stages and commits any uncommitted changes in a child's worktree with a Conventional Commit message. */
export async function settleWorktree(deps: SettleDeps, child: Session, commitContext?: CommitContext): Promise<SettleOutcome> {
  const { context, getProject, quiesce, release } = deps;
  const project = getProject(child.project_id);
  if (!project.worktree_path || !['WATCHING', 'LOCAL', 'READY'].includes(project.sync_status)) {
    return { summary: '', commitCount: 0, diffStat: '', changedFiles: [], dormant: project.sync_status === 'DORMANT' };
  }
  await context.workspaces.flush(project);

  const resolvedContext: CommitContext = {
    agentName: commitContext?.agentName ?? child.agent_name,
    branch: commitContext?.branch ?? project.worktree_branch,
    task: commitContext?.task,
    report: commitContext?.report,
    commitMessage: commitContext?.commitMessage,
  };

  let count = 0;
  let stat = '';
  let changedFiles: ChangedFileEntry[] = [];

  if (isClientProject(context, project)) {
    const statusFiles = await clientGitStatusFiles(context, project.dev_host_id, project.worktree_path);
    const message = buildCommitMessage({
      kind: 'settle',
      ...resolvedContext,
      files: statusFiles,
    });
    const result = await context.clientWorkspaceAdapter.gitWorktree<ClientCommitResult>(project.dev_host_id, {
      op: 'commit',
      worktreePath: project.worktree_path,
      base: project.worktree_base!,
      message,
    });
    count = Number(result?.commitCount ?? 0);
    stat = String(result?.diffStat ?? '');
    changedFiles = mergeChangedFiles(statusFiles, parseDiffStatPaths(stat));
  } else {
    const baseRef = shellQuote(project.worktree_base!);
    const inspectOutput = await runGitShell(context, project, `cd -- ${shellQuote(project.worktree_path)}
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    printf 'staged\\0'
    git -c core.quotepath=false diff --cached --name-status
    exit 0
  fi
fi
printf 'clean\\0%s\\0' "$(git rev-list --count ${baseRef}..HEAD)"
git -c core.quotepath=false diff --stat ${baseRef}..HEAD | tail -n 40`);

    const [state, second = '', third = ''] = inspectOutput.split('\0');
    if (state === 'staged') {
      const stagedFiles = parseNameStatus(second);
      const message = buildCommitMessage({
        kind: 'settle',
        ...resolvedContext,
        files: stagedFiles,
      });
      const commitOutput = await runGitShell(context, project, `cd -- ${shellQuote(project.worktree_path)}
${gitIdentity}
if ! git diff --cached --quiet; then
  ${gitCommitCommand(message)}
fi
printf '%s\\0' "$(git rev-list --count ${baseRef}..HEAD)"
git -c core.quotepath=false diff --stat ${baseRef}..HEAD | tail -n 40`);
      const [rawCount, rawStat = ''] = commitOutput.split('\0');
      count = Number(rawCount);
      stat = rawStat;
      changedFiles = mergeChangedFiles(stagedFiles, parseDiffStatPaths(stat));
    } else {
      count = Number(second);
      stat = third;
      changedFiles = parseDiffStatPaths(stat);
    }
  }

  if (count === 0) {
    if (!await quiesce(child)) {
      context.store.run('UPDATE projects SET worktree_state=NULL WHERE id=?', project.id);
      return { summary: '', commitCount: 0, diffStat: stat, changedFiles: [], dormant: false };
    }
    await release(project);
    context.store.run("UPDATE projects SET sync_status='DORMANT',worktree_state=NULL WHERE id=?", project.id);
    return {
      summary: '[worktree] 没有修改文件，worktree 和分支已清理；再发消息时会从最新的提交重新创建。',
      commitCount: 0,
      diffStat: '',
      changedFiles: [],
      dormant: true,
    };
  }

  context.store.run("UPDATE projects SET worktree_state='changes' WHERE id=?", project.id);
  return {
    summary: `[worktree] 修改已提交到分支 ${project.worktree_branch}（${count} 个提交，基于 ${project.worktree_base!.slice(0, 10)}）：\n${stat.trim()}\n用 merge_agent 合并到主目录，或用 discard_agent 丢弃。`,
    commitCount: count,
    diffStat: stat,
    changedFiles,
    dormant: false,
  };
}
