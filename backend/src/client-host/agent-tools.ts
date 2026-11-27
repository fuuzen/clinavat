import { z } from 'zod';
import type { AgentContext, HubTool } from '../agent/types.js';
import {
  assertClientPath, assertPortableFilename, isProtectedInternalSegment, normalizePlatform,
  normalizeRelativePath, type ClientPlatform,
} from './path-utils.js';

export const clientReadToolNames = [
  'client_read_file', 'client_list_dir', 'client_glob', 'client_grep',
] as const;

export const clientWriteToolNames = [
  'client_write_file', 'client_edit_file', 'client_apply_patch', 'client_exec_command', 'client_manage_task',
] as const;

export type ClientReadToolName = typeof clientReadToolNames[number];
export type ClientWriteToolName = typeof clientWriteToolNames[number];
export type ClientDirectToolName = ClientReadToolName | ClientWriteToolName;

const readToolSet = new Set<string>(clientReadToolNames);

export const clientToolInputs = {
  client_read_file: z.object({
    path: z.string().trim().min(1).max(4096).describe('Project-relative or client-native absolute file path inside the workspace.'),
    offset: z.number().int().min(0).optional().describe('1-based starting line number (0 is treated as 1).'),
    limit: z.number().int().min(1).max(2000).optional().describe('Maximum number of lines to return (default 400, max 2000).'),
    byteOffset: z.number().int().min(0).optional().describe('Optional 0-based byte offset for raw byte range slicing.'),
    maxBytes: z.number().int().min(1).max(262_144).optional().describe('Maximum UTF-8 bytes to return (default 65536, max 262144).'),
  }),
  client_list_dir: z.object({
    path: z.string().trim().max(4096).optional().describe('Directory path relative to workspace root (or native absolute path inside workspace). Omit for root.'),
  }),
  client_glob: z.object({
    pattern: z.string().trim().min(1).max(512).describe('Glob pattern relative to the search directory (e.g. "src/**/*.ts").'),
    path: z.string().trim().max(4096).optional().describe('Optional subdirectory to search within.'),
    maxResults: z.number().int().min(1).max(500).optional().describe('Maximum number of matching file paths (default 200, max 500).'),
  }),
  client_grep: z.object({
    pattern: z.string().min(1).max(1024).describe('Regex or literal text pattern to search for.'),
    path: z.string().trim().max(4096).optional().describe('Optional file or subdirectory to narrow the search.'),
    glob: z.string().trim().max(256).optional().describe('Optional file glob filter (e.g. "*.ts").'),
    caseInsensitive: z.boolean().optional().describe('Set true for case-insensitive search.'),
    maxResults: z.number().int().min(1).max(500).optional().describe('Maximum number of matching lines (default 100, max 500).'),
  }),
  client_write_file: z.object({
    path: z.string().trim().min(1).max(4096).describe('File path to create or overwrite inside the workspace.'),
    content: z.string().max(4 * 1024 * 1024).describe('Full UTF-8 text content to write.'),
    createDirs: z.boolean().optional().describe('Create missing parent directories (default true).'),
  }),
  client_edit_file: z.object({
    path: z.string().trim().min(1).max(4096).describe('File path to edit inside the workspace.'),
    oldText: z.string().min(1).max(1024 * 1024).describe('Exact existing text to replace.'),
    newText: z.string().max(1024 * 1024).describe('Replacement text.'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence when true; otherwise requires a unique match.'),
  }),
  client_apply_patch: z.object({
    patch: z.string().trim().min(1).max(2 * 1024 * 1024).describe('Unified diff or apply_patch payload targeting files inside the workspace.'),
  }),
  client_exec_command: z.object({
    command: z.string().trim().min(1).max(65_536).describe('Shell command to run on the client machine using its target OS and shell syntax.'),
    cwd: z.string().trim().max(4096).optional().describe('Working directory inside the workspace (relative or client absolute). Defaults to workspace root.'),
    shell: z.string().trim().min(1).max(256).optional().describe('Optional shell override (e.g. pwsh, powershell, cmd, bash, zsh).'),
    env: z.record(z.string(), z.string()).optional().describe('Optional extra environment variables.'),
    background: z.boolean().optional().describe('Run as a tracked background task when true.'),
    waitMsBeforeAsync: z.number().int().min(0).max(120_000).optional().describe('Wait up to this many ms before moving a long command to background.'),
  }),
  client_manage_task: z.object({
    action: z.enum(['list', 'status', 'send_input', 'kill']).describe('Background task management action scoped to the current session.'),
    taskId: z.string().trim().min(1).max(128).optional().describe('Required for status, send_input and kill.'),
    input: z.string().max(65_536).optional().describe('Text input to write to stdin when action is send_input.'),
  }),
};

const descriptions: Record<ClientDirectToolName, string> = {
  client_read_file: 'Reads a UTF-8 text file directly from the user\'s client machine, with optional line (offset/limit) or byte (byteOffset/maxBytes) slicing.',
  client_list_dir: 'Lists files and subdirectories in a directory on the user\'s client machine with entry types and file sizes.',
  client_glob: 'Finds files matching a glob pattern inside the client workspace.',
  client_grep: 'Searches file contents inside the client workspace using a regex or text pattern.',
  client_write_file: 'Creates or overwrites a text file on the client machine after showing a unified diff preview for user approval.',
  client_edit_file: 'Replaces an exact text block in a file on the client machine after diff preview and user approval.',
  client_apply_patch: 'Validates a multi-file patch on the client machine (dry-run), requests user approval with the diff preview, then applies it.',
  client_exec_command: 'Executes a shell command directly on the user\'s client machine inside the workspace after user approval.',
  client_manage_task: 'Lists, inspects, sends input to, or kills background tasks started by this session on the client machine.',
};

const allClientTools: HubTool[] = (Object.entries(clientToolInputs) as [ClientDirectToolName, z.ZodType][]).map(([name, schema]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return { name, description: descriptions[name], inputSchema };
});

export function isClientDirectToolName(name: string): name is ClientDirectToolName {
  return Object.hasOwn(clientToolInputs, name);
}

export function isClientDirectReadTool(name: string): name is ClientReadToolName {
  return readToolSet.has(name);
}

/** Exposes all 9 client tools for writable direct sessions, or only the 4 read-only tools for read-only children. */
export function clientDirectToolsFor(context: Pick<AgentContext, 'session'>): HubTool[] {
  if (context.session.agent_access === 'read') {
    return allClientTools.filter(tool => readToolSet.has(tool.name));
  }
  return allClientTools;
}

export function effectiveClientPlatform(context: Pick<AgentContext, 'host' | 'project'>): ClientPlatform {
  if (context.host?.platform) return normalizePlatform(context.host.platform);
  if (/^[A-Za-z]:[\\/]/.test(context.project.remote_path)) return 'windows';
  return 'linux';
}

function joinClientSegments(platform: ClientPlatform, base: string, segments: string[]): string {
  const clean = assertClientPath(platform, base);
  if (!segments.length) return clean;
  if (platform === 'windows') {
    return clean.endsWith('\\') ? `${clean}${segments.join('\\')}` : `${clean}\\${segments.join('\\')}`;
  }
  return clean === '/' ? `/${segments.join('/')}` : `${clean}/${segments.join('/')}`;
}

function parseAbsoluteSegments(platform: ClientPlatform, absolutePath: string): { rootKey: string; segments: string[] } {
  const normalized = assertClientPath(platform, absolutePath);
  if (platform === 'windows') {
    const drive = normalized[0]!.toLowerCase();
    const rest = normalized.slice(3).split('\\').filter(Boolean);
    return { rootKey: drive, segments: rest };
  }
  return { rootKey: '/', segments: normalized.split('/').filter(Boolean) };
}

/** Computes the locked client root: `<project.remote_path>/<agent_directory>` when a child is scoped to a directory. */
export function effectiveClientRoot(context: Pick<AgentContext, 'host' | 'project' | 'session'>): {
  platform: ClientPlatform;
  root: string;
  baseRel: string;
} {
  const platform = effectiveClientPlatform(context);
  const baseRel = normalizeRelativePath(context.session.agent_directory ?? '', { allowEmpty: true, platform });
  const root = joinClientSegments(platform, context.project.remote_path, baseRel ? baseRel.split('/') : []);
  return { platform, root, baseRel };
}

export interface ResolvedClientPath {
  platform: ClientPlatform;
  root: string;
  relPath: string;
  clientPath: string;
}

/**
 * Validates and resolves a relative or client-native absolute path against the locked effective root.
 * When `session.agent_directory` is set, escaping back to the parent project directory is always rejected.
 */
export function resolveClientToolPath(
  context: Pick<AgentContext, 'host' | 'project' | 'session'>,
  rawPath: string | undefined,
  options: { allowEmpty?: boolean; forWrite?: boolean } = {},
): ResolvedClientPath {
  const { platform, root } = effectiveClientRoot(context);
  const value = (rawPath ?? '').trim();
  if (/[\0\r\n]/.test(value) || value.length > 4096) throw new Error('路径包含非法字符或超出长度限制');
  if (value.startsWith('\\\\') || value.startsWith('//')) throw new Error('不支持 UNC 网络路径或设备路径');
  if (!value || value === '.') {
    if (!options.allowEmpty) throw new Error('路径不能为空');
    return { platform, root, relPath: '', clientPath: root };
  }

  let relPath: string;
  const isWinAbs = platform === 'windows' && /^[A-Za-z]:[\\/]/.test(value);
  const isPosixAbs = platform !== 'windows' && value.startsWith('/');
  if (isWinAbs || isPosixAbs) {
    const target = parseAbsoluteSegments(platform, value);
    const base = parseAbsoluteSegments(platform, root);
    if (target.rootKey !== base.rootKey || target.segments.length < base.segments.length) {
      throw new Error('路径超出当前允许的工作目录范围');
    }
    for (let i = 0; i < base.segments.length; i++) {
      const matches = platform === 'windows'
        ? target.segments[i]!.toLowerCase() === base.segments[i]!.toLowerCase()
        : target.segments[i] === base.segments[i];
      if (!matches) throw new Error('路径超出当前允许的工作目录范围');
    }
    const relSegments = target.segments.slice(base.segments.length);
    for (const segment of relSegments) {
      if (isProtectedInternalSegment(segment)) throw new Error('不能访问 .git 或 .bin 等受保护内部目录');
    }
    relPath = normalizeRelativePath(relSegments.join('/'), { allowEmpty: options.allowEmpty, platform });
  } else {
    if (platform === 'windows' && (/^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\'))) {
      throw new Error('路径超出当前允许的工作目录范围或格式无效');
    }
    const normalizedSep = platform === 'windows' ? value.replace(/\\/g, '/') : value;
    const stripped = normalizedSep.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    if (!stripped || stripped === '.') {
      if (!options.allowEmpty) throw new Error('路径不能为空');
      return { platform, root, relPath: '', clientPath: root };
    }
    relPath = normalizeRelativePath(stripped, { allowEmpty: options.allowEmpty, platform });
  }

  if (options.forWrite && relPath) assertPortableFilename(platform, relPath);
  const clientPath = joinClientSegments(platform, root, relPath ? relPath.split('/') : []);
  return { platform, root, relPath, clientPath };
}

/** Rejects glob/filter patterns that traverse upward, are absolute, or target `.git`/`.bin`/ADS/8.3 segments. */
export function assertSafeGlobPattern(pattern: string, platform: ClientPlatform): void {
  if (!pattern || /[\0\r\n]/.test(pattern) || pattern.length > 512) throw new Error('搜索模式无效');
  if (pattern.startsWith('\\\\') || pattern.startsWith('//')) throw new Error('搜索模式不能使用 UNC 路径');
  const trimmed = pattern.replace(/^!+/, '');
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) throw new Error('搜索模式必须为项目内相对路径');
  for (const segment of trimmed.replace(/\\/g, '/').split('/')) {
    if (!segment) continue;
    if (segment === '..') throw new Error('搜索模式不能包含上级目录回溯（..）');
    if (platform === 'windows' && segment.includes(':')) throw new Error(`Windows 搜索模式不能包含冒号：${segment}`);
    if (isProtectedInternalSegment(segment)) throw new Error('不能搜索 .git 或 .bin 等受保护内部目录');
  }
}

export { extractPatchPaths } from './patch-paths.js';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_KEY_LENGTH = 128;
const MAX_ENV_VALUE_LENGTH = 8 * 1024;
const MAX_ENV_TOTAL_BYTES = 64 * 1024;

/** Validates extra environment variables passed to `client_exec_command`. */
export function validateCommandEnv(rawEnv: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rawEnv) return undefined;
  const entries = Object.entries(rawEnv);
  if (!entries.length) return undefined;
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new Error(`环境变量数量超过上限（最多 ${MAX_ENV_ENTRIES} 个）`);
  }
  const validated: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_ENV_KEY_LENGTH || key.includes('\0') || !ENV_KEY_RE.test(key)) {
      throw new Error(`环境变量名无效：${key}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`环境变量 ${key} 的值包含非法空字节`);
    }
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      throw new Error(`环境变量 ${key} 的值超过长度上限（${MAX_ENV_VALUE_LENGTH} 字符）`);
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes > MAX_ENV_TOTAL_BYTES) {
      throw new Error('环境变量总大小超过 64 KiB 上限');
    }
    Object.defineProperty(validated, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return validated;
}

export function formatApprovalCommand(command: string, env: Record<string, string> | undefined): string {
  if (!env) return command;
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return pairs.length ? `[env: ${pairs.join(' ')}] ${command}` : command;
}

const MAX_DIFF_PREVIEW_CHARS = 32 * 1024;

/** Builds a compact unified-diff preview for user approval prompts without external dependencies. */
export function buildUnifiedDiff(relPath: string, before: string | null, after: string): string {
  const oldLines = before === null ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const newLines = after.replace(/\r\n/g, '\n').split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  const ctxStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const header = [
    `--- ${before === null ? '/dev/null' : `a/${relPath}`}`,
    `+++ b/${relPath}`,
    `@@ -${ctxStart + 1},${Math.max(0, oldEnd - ctxStart)} +${ctxStart + 1},${Math.max(0, newEnd - ctxStart)} @@`,
  ];
  const body: string[] = [];
  for (let i = ctxStart; i < prefix; i++) body.push(` ${oldLines[i]}`);
  for (let i = prefix; i < oldLines.length - suffix; i++) body.push(`-${oldLines[i]}`);
  for (let i = prefix; i < newLines.length - suffix; i++) body.push(`+${newLines[i]}`);
  for (let i = newLines.length - suffix; i < newEnd; i++) body.push(` ${newLines[i]}`);
  const diff = [...header, ...body].join('\n');
  return diff.length > MAX_DIFF_PREVIEW_CHARS
    ? `${diff.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n... [diff preview truncated]`
    : diff;
}
