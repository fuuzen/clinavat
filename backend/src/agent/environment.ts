import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AgentContext } from './types.js';

export const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function agentEnvironment(context: AgentContext): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return {
    ...environment,
    HOME: context.slot.home_dir,
    XDG_CONFIG_HOME: path.join(context.slot.home_dir, '.config'),
    XDG_CACHE_HOME: path.join(context.slot.home_dir, '.cache'),
    CODEX_HOME: path.join(context.slot.home_dir, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(context.slot.home_dir, '.claude'),
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
  };
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

export function terminateProcess(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* The CLI may have already exited. */ }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* The process group may have already exited. */ }
  }, 5000);
  force.unref();
  child.once('close', () => clearTimeout(force));
}
