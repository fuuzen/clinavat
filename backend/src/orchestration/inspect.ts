import { posix } from 'node:path';
import { z } from 'zod';
import { superReadModeOf } from '../agent/orchestration-tools.js';
import type { AgentContext, HubToolResult } from '../agent/types.js';
import { HttpError, type Project } from '../models.js';
import { assertReadableReference, visibleProjectPath, type PathCompletion } from '../runtime/project-completions.js';
import type { WorkspaceManager } from '../runtime/workspace.js';

export const inspectInput = z.object({
  action: z.enum(['tree', 'read']),
  force: z.boolean().default(false).describe('Re-read the file even if unchanged since the last read in this session (e.g. after context compaction).'),
  path: z.string().trim().max(1024).optional().describe('A project-relative path. Omit for the project root with tree.'),
  maxDepth: z.number().int().min(1).max(3).default(2).describe('Tree depth measured from the requested directory.'),
});

const limits = { overview: { calls: 6, bytes: 48 * 1024 }, full: { calls: 12, bytes: 96 * 1024 } };
const fileLimit = 16 * 1024;
const treeLimit = 200;
const rootManifests = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile',
  'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);
const runtimeDirectories = new Set(['.gemini', '.clinavat', '.system_generated']);
const budgetError = '本轮 inspect 配额已用完，请委派 explorer 子智能体继续检视。';
const unchanged = '文件自本会话上次读取后未变更，请直接复用上下文内容。';

interface TurnBudget { id: string; calls: number; bytes: number }
interface FileVersion { mtimeMs: number; size: number }
interface NativeFileCache { nativeId: string; files: Map<string, FileVersion> }

function overviewDocument(path: string): boolean {
  if (path.startsWith('runs/')) return path.endsWith('/SUMMARY.md');
  const name = posix.basename(path);
  return (!path.includes('/') && rootManifests.has(name))
    || /\.(?:md|mdx|txt|rst)$/i.test(name)
    || /^(?:LICENSE|CHANGELOG)(?:[-_][\w-]+)?$/i.test(name)
    || path.startsWith('docs/') && (/\.(?:adoc|asciidoc|org|textile)$/i.test(name) || /^README$/i.test(name));
}

const sameVersion = (left: FileVersion | undefined, right: FileVersion) =>
  left?.mtimeMs === right.mtimeMs && left.size === right.size;

export class ProjectInspector {
  private readonly budgets = new WeakMap<AgentContext['session'], TurnBudget>();
  private readonly cache = new Map<string, NativeFileCache>();

  constructor(private readonly workspaces: WorkspaceManager) {}

  clearSession(sessionId: string): void { this.cache.delete(sessionId); }

  async inspect(agent: AgentContext, project: Project, args: unknown, signal: AbortSignal): Promise<HubToolResult> {
    const mode = superReadModeOf(agent.session);
    if (mode === 'off') throw new HttpError(403, '当前读取档位为 off，请委派 explorer 子智能体检视项目。');
    const turnId = agent.session.turn_id;
    if (!turnId) throw new HttpError(409, 'inspect 只能在当前轮次内调用。');
    let budget = this.budgets.get(agent.session);
    if (budget?.id !== turnId) {
      budget = { id: turnId, calls: 0, bytes: 0 };
      this.budgets.set(agent.session, budget);
    }
    const limit = limits[mode];
    if (budget.calls >= limit.calls) throw new HttpError(429, budgetError);
    budget.calls++;

    const input = inspectInput.parse(args);
    const requested = input.path || '.';
    if (!this.visible(project, requested)) throw new HttpError(403, '只能检视项目内的可见路径。');
    const path = posix.normalize(requested).replace(/\/$/, '');
    await assertReadableReference(this.workspaces, project, path);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (agent.session.turn_id !== turnId) throw new HttpError(409, 'inspect 所属轮次已结束。');
    };
    assertCurrent();
    if (input.action === 'tree') return this.tree(project, path, input.maxDepth, assertCurrent);
    if (mode === 'overview' && !overviewDocument(path)) {
      throw new HttpError(403, 'overview 仅可读取项目文档和根目录工程清单，请委派 explorer 子智能体查看此文件。');
    }
    return this.read(agent, project, path, budget, limit.bytes, input.force, assertCurrent);
  }

  private visible(project: Project, path: string): boolean {
    return visibleProjectPath(this.workspaces, project, path) && !path.split('/').some(part => runtimeDirectories.has(part));
  }

  private async tree(project: Project, path: string, maxDepth: number, assertCurrent: () => void): Promise<HubToolResult> {
    const entries: PathCompletion[] = [];
    const queue = [{ path, depth: 1 }];
    for (const current of queue) {
      assertCurrent();
      const { entries: children } = await this.workspaces.files(project, current.path === '.' ? '' : current.path, { followLinks: false });
      assertCurrent();
      for (const child of children) {
        if (!this.visible(project, child.path)) continue;
        if (entries.length === treeLimit) return { text: JSON.stringify({ path, entries, truncated: true }) };
        entries.push({ path: child.path, type: child.type });
        if (child.type === 'directory' && current.depth < maxDepth) queue.push({ path: child.path, depth: current.depth + 1 });
      }
    }
    return { text: JSON.stringify({ path, entries, truncated: false }) };
  }

  private async read(agent: AgentContext, project: Project, path: string, budget: TurnBudget, byteLimit: number, force: boolean,
    assertCurrent: () => void): Promise<HubToolResult> {
    const files = this.filesFor(agent);
    if (this.workspaces.isClientDirect(project)) {
      const meta = await this.workspaces.stat(project, path);
      assertCurrent();
      if (!meta.exists || meta.kind !== 'file' || meta.isSymlink) throw new HttpError(404, '文件不存在或无法访问');
      const version = { mtimeMs: meta.mtimeMs ?? 0, size: meta.size ?? 0 };
      if (!force && sameVersion(files?.get(path), version)) return { text: unchanged };
      const length = Math.min(version.size, fileLimit);
      if (budget.bytes + length > byteLimit) throw new HttpError(429, budgetError);
      const slice = await this.workspaces.readSlice(project, path, fileLimit);
      assertCurrent();
      if (budget.bytes + slice.buffer.length > byteLimit) throw new HttpError(429, budgetError);
      const truncated = slice.size > slice.buffer.length;
      let content: string;
      try {
        if (slice.isBinary || slice.buffer.includes(0)) throw new Error('NUL');
        content = new TextDecoder('utf-8', { fatal: true }).decode(slice.buffer, { stream: truncated });
      } catch { throw new HttpError(400, 'inspect 仅支持 UTF-8 文本文件。'); }
      budget.bytes += slice.buffer.length;
      if (files) {
        if (files.size >= 256 && !files.has(path)) files.delete(files.keys().next().value!);
        files.set(path, { mtimeMs: slice.mtimeMs, size: slice.size });
      }
      return { text: JSON.stringify({ path, content, truncated }) };
    }
    const raw = await this.workspaces.rawFile(project, path, { followLinks: false });
    if (!('stat' in raw.handle)) {
      await raw.handle.close();
      throw new HttpError(500, '不支持的文件句柄类型');
    }
    const { handle } = raw;
    try {
      const version = await handle.stat();
      assertCurrent();
      if (!force && sameVersion(files?.get(path), version)) return { text: unchanged };
      const length = Math.min(version.size, fileLimit);
      if (budget.bytes + length > byteLimit) throw new HttpError(429, budgetError);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const after = await handle.stat();
      assertCurrent();
      if (!sameVersion(version, after) || bytesRead !== length) throw new HttpError(409, '文件在读取时发生变化，请重试。');
      if (!force && sameVersion(files?.get(path), version)) return { text: unchanged };
      if (budget.bytes + bytesRead > byteLimit) throw new HttpError(429, budgetError);
      const truncated = version.size > length;
      let content: string;
      try {
        if (buffer.includes(0)) throw new Error('NUL');
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: truncated });
      } catch { throw new HttpError(400, 'inspect 仅支持 UTF-8 文本文件。'); }
      budget.bytes += bytesRead;
      if (files) {
        if (files.size >= 256 && !files.has(path)) files.delete(files.keys().next().value!);
        files.set(path, { mtimeMs: version.mtimeMs, size: version.size });
      }
      return { text: JSON.stringify({ path, content, truncated }) };
    } finally { await handle.close(); }
  }

  private filesFor(agent: AgentContext): Map<string, FileVersion> | undefined {
    const { id, native_session_id: nativeId } = agent.session;
    const saved = this.cache.get(id);
    this.cache.delete(id);
    if (!nativeId) return undefined;
    const current = saved?.nativeId === nativeId ? saved : { nativeId, files: new Map<string, FileVersion>() };
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, current);
    return current.files;
  }
}
