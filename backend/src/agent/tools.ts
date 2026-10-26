import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentEnvironment, terminateProcess, workspacePath } from './environment.js';
import type { RunServices } from './types.js';

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const stringProperty = { type: 'string' };
export const dynamicTools = [
  tool('remote_command', 'Run a synchronous shell command on the project development host, with synchronization barriers. All compilation, git, terminals and shell commands MUST use this tool.', {
    command: stringProperty, cwd: { type: 'string', description: 'Project-relative directory, defaults to .' },
  }, ['command']),
  tool('workspace_read', 'Read a UTF-8 source file from the local project mirror.', { path: stringProperty }, ['path']),
  tool('workspace_list', 'List files in a local project mirror directory.', { path: stringProperty }, []),
  tool('workspace_search', 'Search source files for a literal case-sensitive string. Results are bounded. Use path to narrow the search.', {
    query: stringProperty, path: stringProperty,
  }, ['query']),
  tool('workspace_write', 'Create or replace a UTF-8 project source file after explicit user approval.', {
    path: stringProperty, content: stringProperty,
  }, ['path', 'content']),
  tool('workspace_replace', 'Replace one exact occurrence of oldText in a project source file after explicit user approval.', {
    path: stringProperty, oldText: stringProperty, newText: stringProperty,
  }, ['path', 'oldText', 'newText']),
];

const excluded = new Set(['.bin', '.git', '.claude', '.codex', 'node_modules', 'dist', 'build', 'target', '.venv']);
const maximumFileSize = 2 * 1024 * 1024;

async function readSource(filePath: string): Promise<string> {
  if ((await stat(filePath)).size > maximumFileSize) throw new Error('文件超过 2 MiB，请缩小读取范围');
  const contents = await readFile(filePath, 'utf8');
  if (contents.includes('\0')) throw new Error('仅支持 UTF-8 文本源码文件');
  return contents;
}

function requireString(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') throw new Error(`参数 ${key} 必须为字符串`);
  return input[key];
}

export async function executeDynamicTool(services: RunServices, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('会话已停止');
  const root = services.context.project.local_path;
  if (name === 'remote_command') {
    const command = requireString(input, 'command');
    if (command.length > 128 * 1024) throw new Error('命令过长');
    const cwd = await workspacePath(root, String(input.cwd ?? '.'));
    const approval = await services.approve('remote_command', { command, cwd });
    if (approval.decision !== 'allow') throw new Error(approval.reason ?? '用户拒绝执行命令');
    if (signal.aborted) throw new Error('会话已停止');
    await services.verifyShell();
    if (signal.aborted) throw new Error('会话已停止');
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(root, '.bin', 'remote-shell'), ['-c', command], {
        cwd, env: agentEnvironment(services.context), detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let contents = '';
      const abort = () => terminateProcess(child);
      signal.addEventListener('abort', abort, { once: true });
      const append = (text: string) => {
        if (contents.length < maximumFileSize) contents += text.slice(0, maximumFileSize - contents.length);
        services.event('tool', { tool: name, output: text.slice(0, 128 * 1024), status: 'running', append: true });
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) => { signal.removeEventListener('abort', abort); reject(error); });
      child.once('close', (code, exitSignal) => {
        signal.removeEventListener('abort', abort);
        resolve(`Exit code: ${code ?? exitSignal}\n${contents}`);
      });
    });
  }
  const requested = name === 'workspace_list' || name === 'workspace_search'
    ? String(input.path ?? '.') : requireString(input, 'path');
  const target = await workspacePath(root, requested, name === 'workspace_write');
  if (name === 'workspace_read') return readSource(target);
  if (name === 'workspace_list') {
    const entries = await readdir(target, { withFileTypes: true });
    return JSON.stringify(entries.filter((entry) => !excluded.has(entry.name) && !entry.isSymbolicLink())
      .slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })));
  }
  if (name === 'workspace_search') {
    const query = requireString(input, 'query');
    if (!query || query.length > 4096) throw new Error('搜索词长度应为 1 至 4096');
    const matches: { path: string; line: number; text: string }[] = [];
    const queue = [target];
    let examined = 0;
    while (queue.length && examined < 2000 && matches.length < 100 && !signal.aborted) {
      const current = await workspacePath(root, queue.shift()!).catch(() => undefined);
      if (!current) continue;
      const metadata = await stat(current);
      if (metadata.isDirectory()) {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (!excluded.has(entry.name) && !entry.isSymbolicLink()) queue.push(path.join(current, entry.name));
          if (queue.length > 4000) break;
        }
      } else if (metadata.isFile() && metadata.size <= maximumFileSize) {
        examined++;
        const content = await readSource(await workspacePath(root, current)).catch(() => '');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length && matches.length < 100; index++) {
          if (lines[index]!.includes(query)) matches.push({ path: path.relative(root, current), line: index + 1, text: lines[index]!.slice(0, 1000) });
        }
      }
    }
    return JSON.stringify({ matches, truncated: matches.length === 100 || examined === 2000 });
  }
  if (name === 'workspace_write' || name === 'workspace_replace') {
    const original = await readSource(target).catch((error: NodeJS.ErrnoException) => {
      if (name === 'workspace_write' && error.code === 'ENOENT') return null;
      throw error;
    });
    let contents: string;
    if (name === 'workspace_write') contents = requireString(input, 'content');
    else {
      const oldText = requireString(input, 'oldText');
      if (!oldText || original === null || original.indexOf(oldText) === -1 || original.indexOf(oldText) !== original.lastIndexOf(oldText)) {
        throw new Error('oldText 必须在文件中精确匹配一次');
      }
      contents = original.replace(oldText, () => requireString(input, 'newText'));
    }
    if (Buffer.byteLength(contents) > maximumFileSize || contents.includes('\0')) throw new Error('仅支持不超过 2 MiB 的文本文件');
    const approval = await services.approve(name, { ...input, previousContent: original });
    if (approval.decision !== 'allow') throw new Error(approval.reason ?? '用户拒绝修改文件');
    if (signal.aborted) throw new Error('会话已停止');
    await workspacePath(root, requested, name === 'workspace_write');
    const current = await readSource(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== original) throw new Error('审批期间文件发生变化，请重新读取后修改');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
    return `已更新 ${path.relative(root, target)}`;
  }
  throw new Error(`不支持的工具：${name}`);
}
