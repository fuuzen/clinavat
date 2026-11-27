import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ExecutionHost, ExecutionScope } from '../execution/types.js';
import type { AgentContext } from './types.js';

export const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function agentEnvironment(execution: ExecutionHost, context: Omit<AgentContext, 'project'>, scope: ExecutionScope): NodeJS.ProcessEnv {
  return {
    ...execution.baseEnvironment(scope),
    HOME: context.runtime_home,
    XDG_CONFIG_HOME: path.join(context.runtime_home, '.config'),
    XDG_CACHE_HOME: path.join(context.runtime_home, '.cache'),
    CODEX_HOME: path.join(context.runtime_home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(context.runtime_home, '.claude'),
    // agy otherwise replaces its own binary in the background; the image pins its version.
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    ...(context.runtime_kind !== 'probe' && context.session.id ? { CLINAVAT_SESSION_ID: context.session.id } : {}),
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
  };
}

const DEFAULT_WORKSPACE_DIR = '/var/tmp/clinavat-workspace';

/** Shared read-only empty directory mounted into slot VMs for Mode 1 (client direct) runs. */
export function clientDirectEmptyDir(workspaceDir?: string): string {
  return path.join(workspaceDir || DEFAULT_WORKSPACE_DIR, '.client-direct-empty');
}

/** The project root path as seen inside the CLI's execution environment (LXD slot VM or Hub process). */
export function vmProjectRoot(context: AgentContext, workspaceDir?: string): string {
  if (context.host?.kind === 'client') {
    if (context.project.client_mode !== 'mirrored') return clientDirectEmptyDir(workspaceDir);
    return context.project.vm_path || context.project.local_path;
  }
  return context.project.local_path;
}

/** The working directory passed as `cwd` to the CLI process inside the slot VM. */
export function vmWorkingDirectory(context: AgentContext, workspaceDir?: string): string {
  if (context.host?.kind === 'client') {
    if (context.project.client_mode !== 'mirrored') return clientDirectEmptyDir(workspaceDir);
    const root = context.project.vm_path || context.project.local_path;
    return context.session.agent_directory ? path.posix.join(root, context.session.agent_directory) : root;
  }
  return context.session.agent_directory ? path.join(context.project.local_path, context.session.agent_directory) : context.project.local_path;
}

export function agentScope(context: AgentContext, workspaceDir?: string): ExecutionScope {
  if (context.host?.kind === 'client') {
    if (context.project.client_mode !== 'mirrored') {
      // Mode 1 (direct): mount only one shared read-only empty directory so the CLI sees no Hub mirror files.
      return {
        userId: context.user.id,
        slotId: context.slot.id,
        paths: [context.runtime_home],
        readOnlyPaths: [clientDirectEmptyDir(workspaceDir)],
      };
    }
    // Mode 2 (mirrored): mount the mirror once at `vm_path` via `mounts`, omitting `local_path` from `paths`.
    const target = context.project.vm_path || context.project.local_path;
    return {
      userId: context.user.id,
      slotId: context.slot.id,
      paths: [context.runtime_home],
      mounts: [{ source: context.project.local_path, target, readonly: context.session.agent_access === 'read' }],
    };
  }
  return { userId: context.user.id, slotId: context.slot.id, paths: [context.runtime_home, context.project.local_path],
    // The host command key reaches local-project runs only.
    ...(context.project.host_shell ? { readOnlyPaths: [path.dirname(context.project.host_shell)] } : {}) };
}

export async function findExecutable(binary: string): Promise<string> {
  const candidates = binary.includes(path.sep)
    ? [path.resolve(binary)]
    : (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`CLI 不可用：${binary}。请先安装官方 CLI 并完成槽位登录。`);
}

export async function workspacePath(root: string, requested = '.', allowMissing = false): Promise<string> {
  if (requested.includes('\0')) throw new Error('路径包含非法字符');
  const rootPath = await realpath(root);
  const candidate = path.resolve(rootPath, requested);
  const relative = path.relative(rootPath, candidate);
  const parts = relative.split(path.sep);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('只能访问当前项目目录');
  }
  if (parts.some((part) => ['.bin', '.claude', '.codex', '.git'].includes(part))) {
    throw new Error('不能访问工作区运行配置或 Git 内部目录');
  }
  let ancestor = candidate;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      const realRelative = path.relative(rootPath, actual);
      if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
        throw new Error('符号链接不能指向当前项目以外');
      }
      const actualParts = realRelative.split(path.sep);
      if (actualParts.some((part) => ['.bin', '.claude', '.codex', '.git'].includes(part))) {
        throw new Error('符号链接不能指向工作区运行配置');
      }
      return candidate;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((await lstat(ancestor).catch(() => undefined))?.isSymbolicLink()) {
        throw new Error('不能写入悬空符号链接');
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

const closedProcesses = new WeakSet<ChildProcess>();
const terminationTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

async function groupIsRunning(group: number): Promise<boolean> {
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ESRCH'].includes(error.code ?? '')) return '';
      throw error;
    });
    const fields = contents.slice(contents.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) return true;
  }
  return false;
}

async function drainProcessGroup(child: ChildProcess): Promise<void> {
  if (process.platform !== 'linux' || !child.pid) return;
  if (!await groupIsRunning(child.pid)) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const forceAt = Date.now() + 5000;
  const deadline = forceAt + 2000;
  while (await groupIsRunning(child.pid)) {
    if (Date.now() >= deadline) throw new Error('CLI 子进程尚未退出，已阻止对话切换和槽位交接');
    if (Date.now() >= forceAt) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await delay(100);
  }
}

export function observeProcessClose(child: ChildProcess): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    let exited = false;
    let pipesClosed = false;
    let drained = false;
    let failure: unknown;
    let pipeDeadline: NodeJS.Timeout | undefined;
    const finish = () => {
      if (!pipesClosed || !drained) return;
      if (pipeDeadline) clearTimeout(pipeDeadline);
      if (failure) reject(failure); else resolve();
    };
    // An escaped background child may keep stdio open after its original process group exits.
    child.once('exit', () => {
      exited = true;
      void drainProcessGroup(child).catch(error => { failure = error; }).finally(() => {
        drained = true;
        if (!pipesClosed) pipeDeadline = setTimeout(() => {
          failure ??= new Error('CLI 退出后仍有后台进程持有输出管道，已停止状态回收');
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          reject(failure);
        }, 1000);
        finish();
      });
    });
    child.once('close', () => {
      closedProcesses.add(child);
      const timer = terminationTimers.get(child);
      if (timer) clearTimeout(timer);
      terminationTimers.delete(child);
      pipesClosed = true;
      if (!exited) drained = true;
      finish();
    });
  });
  void completion.catch(() => undefined);
  return completion;
}

export function terminateProcess(child: ChildProcess): void {
  if (closedProcesses.has(child)) return;
  if (terminationTimers.has(child)) return;
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* The CLI may have already exited. */ }
  const force = setTimeout(() => {
    if (closedProcesses.has(child)) return;
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* The process group may have already exited. */ }
  }, 5000);
  terminationTimers.set(child, force);
  force.unref();
  child.once('close', () => { closedProcesses.add(child); clearTimeout(force); terminationTimers.delete(child); });
}
