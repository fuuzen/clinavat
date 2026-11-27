import { hostFor, type Context } from '../../context.js';
import type { Host, Project } from '../../models.js';
import { runCommand } from '../../runtime/process.js';
import { shellQuote, type CommandResult } from '../../runtime/types.js';
import type { ChangedFileEntry } from './commit-message.js';

export { shellQuote };

// The Hub makes these commits, so repository hooks never run, and a repository without an identity gets a neutral one.
export const gitIdentity = 'if ! git config user.email >/dev/null 2>&1; then export GIT_AUTHOR_NAME=Clinavat GIT_AUTHOR_EMAIL=clinavat@localhost GIT_COMMITTER_NAME=Clinavat GIT_COMMITTER_EMAIL=clinavat@localhost; fi';

export interface ClientInspectResult {
  isRepo?: boolean;
  root?: string;
  target?: string;
  repo?: string;
  head?: string;
  dirty?: boolean;
}

export interface ClientCreateResult {
  worktreePath: string;
  projectRoot?: string;
  childDirectory?: string | null;
}

export interface ClientCommitResult {
  commitCount: number;
  diffStat?: string;
}

export interface ClientMergeResult {
  status: 'merged' | 'conflict' | 'failed';
  commit?: string;
  files?: string[];
  detail?: string;
}

export function hostForProject(context: Context, project: Project): Host {
  return hostFor(context, project.dev_host_id, project.user_id);
}

export function isClientProject(context: Context, project: Project): boolean {
  return hostForProject(context, project).kind === 'client';
}

export async function execGitShell(context: Context, project: Project, script: string, timeout = 120_000): Promise<CommandResult> {
  const body = `set -eu\n${script}`;
  return project.execution_mode === 'local'
    ? runCommand('bash', ['-c', body], { timeout, maxBytes: 1024 * 1024 })
    : context.ssh.exec(project.user_id, hostForProject(context, project), body, timeout, 1024 * 1024);
}

export async function runGitShell(context: Context, project: Project, script: string, timeout?: number): Promise<string> {
  const result = await execGitShell(context, project, script, timeout);
  if (result.code !== 0) {
    throw new Error(`Git 操作失败：${(result.stderr || result.stdout).trim().slice(-2000) || `退出码 ${result.code}`}`);
  }
  return result.stdout;
}

export function sanitizeGitMessage(message: string): string {
  return message.replace(/\0/g, '').replace(/\r\n?/g, '\n');
}

/** Commits staged changes reading the message from stdin via POSIX single-quoted printf to prevent shell injection. */
export function gitCommitCommand(message: string): string {
  const safeMessage = sanitizeGitMessage(message);
  return `printf '%s' ${shellQuote(safeMessage)} | git -c core.hooksPath=/dev/null commit -q --no-verify -F -`;
}

/** Merges or squashes a branch with a safely POSIX-quoted multi-line commit message. */
export function gitMergeCommand(branch: string, mode: 'merge' | 'squash', message: string): string {
  const safeBranch = shellQuote(branch);
  const safeMessage = sanitizeGitMessage(message);
  if (mode === 'squash') {
    return `git -c core.hooksPath=/dev/null merge --squash ${safeBranch} >&2 && ${gitCommitCommand(safeMessage)}`;
  }
  return `git -c core.hooksPath=/dev/null merge --no-ff --no-verify -m ${shellQuote(safeMessage)} ${safeBranch} >&2`;
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\tnr])/g, (_, ch: string) => {
      if (ch === 't') return '\t';
      if (ch === 'n') return '\n';
      if (ch === 'r') return '\r';
      return ch;
    });
  }
  return trimmed;
}

/** Parses `git diff --name-status` output lines into structured changed-file entries. */
export function parseNameStatus(output: string): ChangedFileEntry[] {
  const entries: ChangedFileEntry[] = [];
  for (const rawLine of output.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 2) continue;
    const code = fields[0].trim().toUpperCase();
    const status = code.slice(0, 1) || 'M';
    const filePath = unquoteGitPath((status === 'R' || status === 'C') && fields[2] ? fields[2] : fields[1]);
    if (filePath) entries.push({ status, path: filePath });
  }
  return entries;
}

/** Parses `git status --short` / `--porcelain` lines (such as from client `git.status`). */
export function parseShortStatus(output: string): ChangedFileEntry[] {
  const entries: ChangedFileEntry[] = [];
  for (const rawLine of output.replace(/\r\n?/g, '\n').split('\n')) {
    if (rawLine.length < 4) continue;
    const xy = rawLine.slice(0, 2);
    const rest = rawLine.slice(3).trim();
    if (!rest) continue;
    let status = 'M';
    if (xy === '??') status = 'A';
    else if (xy.includes('R')) status = 'R';
    else if (xy.includes('C')) status = 'C';
    else if (xy.includes('A')) status = 'A';
    else if (xy.includes('D')) status = 'D';
    const arrowIndex = rest.indexOf(' -> ');
    const filePath = unquoteGitPath(arrowIndex >= 0 ? rest.slice(arrowIndex + 4) : rest);
    if (filePath) entries.push({ status, path: filePath });
  }
  return entries;
}

/** Parses `git diff --stat` lines into changed-file entries (used when only diffStat is available from client RPC). */
export function parseDiffStatPaths(diffStat: string): ChangedFileEntry[] {
  const entries: ChangedFileEntry[] = [];
  for (const rawLine of diffStat.replace(/\r\n?/g, '\n').split('\n')) {
    const pipeIndex = rawLine.indexOf(' | ');
    if (pipeIndex <= 0) continue;
    let candidate = rawLine.slice(0, pipeIndex).trim();
    if (!candidate) continue;
    let status = 'M';
    const braceRename = /^(.*)\{[^}]*=>\s*([^}]*)\}(.*)$/.exec(candidate);
    if (braceRename) {
      status = 'R';
      candidate = `${braceRename[1]}${braceRename[2].trim()}${braceRename[3]}`.replace(/\/{2,}/g, '/');
    } else if (candidate.includes(' => ')) {
      status = 'R';
      candidate = candidate.slice(candidate.lastIndexOf(' => ') + 4).trim();
    }
    const filePath = unquoteGitPath(candidate);
    if (filePath) entries.push({ status, path: filePath });
  }
  return entries;
}

export async function clientGitStatusFiles(context: Context, hostId: string, worktreePath: string): Promise<ChangedFileEntry[]> {
  try {
    const snapshot = await context.clientWorkspaceAdapter.gitStatus(hostId, worktreePath);
    return parseShortStatus(snapshot.status);
  } catch {
    return [];
  }
}

export function mergeChangedFiles(...groups: ChangedFileEntry[][]): ChangedFileEntry[] {
  const byPath = new Map<string, ChangedFileEntry>();
  for (const group of groups) {
    for (const entry of group) {
      if (entry.path && !byPath.has(entry.path)) byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()];
}
