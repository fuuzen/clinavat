import { posix } from 'node:path';

export type ClientPlatform = 'windows' | 'macos' | 'linux';

/** Linux system prefixes aligned with `execution/lxd-mounts.ts` that must never be shadowed inside a guest VM. */
export const RESERVED_VM_PREFIXES = [
  '/bin', '/sbin', '/usr', '/lib', '/lib64', '/etc', '/proc', '/sys', '/dev',
  '/run', '/var', '/root', '/home', '/boot', '/opt', '/srv', '/tmp',
] as const;

const WINDOWS_ILLEGAL_CHARS = /[<>:"\\|?*\x00-\x1f]/;
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const PROTECTED_SHORT_NAME = /^\.?(?:git|bin)~\d+(?:\..*)?$/i;
const INVISIBLE_SEGMENT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060\u206a-\u206f\ufeff]/g;
const MAX_PATH_LENGTH = 4096;

/** Matches `.git`/`.bin` across case, NTFS ADS (`:stream`), zero-width chars, trailing dots/spaces, and 8.3 aliases. */
export function isProtectedInternalSegment(segment: string): boolean {
  const cleaned = segment.replace(INVISIBLE_SEGMENT_CHARS, '');
  const base = cleaned.split(':')[0] ?? cleaned;
  const lower = base.toLowerCase();
  if (lower === '.git' || lower === '.bin') return true;
  const stripped = lower.replace(/[. ]+$/, '');
  if (stripped === '.git' || stripped === '.bin') return true;
  return PROTECTED_SHORT_NAME.test(base);
}

export function normalizePlatform(raw: string | undefined): ClientPlatform {
  const lower = (raw ?? '').trim().toLowerCase();
  if (lower === 'win32' || lower === 'windows' || lower.startsWith('win')) return 'windows';
  if (lower === 'darwin' || lower === 'macos' || lower === 'osx' || lower.startsWith('mac')) return 'macos';
  return 'linux';
}

function stripTrailingPosixSlashes(value: string): string {
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * Validates and normalizes an absolute path on a client host.
 * - Windows: requires `C:\...` or `C:/...`, rejects UNC (`\\...`), device paths (`\\?\...`), NUL bytes, and `..`.
 *   Normalizes drive letter to uppercase and separators to backslashes.
 * - macOS / Linux: requires `/` absolute path, rejects NUL bytes, newlines, and `..`.
 */
export function assertClientPath(platform: string, rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string' || rawPath.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(rawPath)) {
    throw new Error('客户端目录路径无效');
  }
  const kind = normalizePlatform(platform);
  if (kind === 'windows') {
    if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
      throw new Error('不支持 Windows UNC 网络路径或设备路径');
    }
    const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(rawPath);
    if (!driveMatch) {
      throw new Error('Windows 目录必须是带盘符的绝对路径（如 C:\\Users\\name\\project）');
    }
    const drive = driveMatch[1]!.toUpperCase();
    const rest = driveMatch[2]!;
    const rawSegments = rest.split(/[\\/]+/);
    const segments: string[] = [];
    for (const segment of rawSegments) {
      if (!segment || segment === '.') continue;
      if (segment === '..') throw new Error('客户端目录路径不能包含上级目录回溯（..）');
      if (/[\x00-\x1f]/.test(segment) || segment.includes(':')) {
        throw new Error(`Windows 路径包含非法字符：${segment}`);
      }
      segments.push(segment);
    }
    return segments.length ? `${drive}:\\${segments.join('\\')}` : `${drive}:\\`;
  }

  if (!rawPath.startsWith('/')) {
    throw new Error('远端目录必须是有效的绝对路径');
  }
  const rawSegments = rawPath.split('/');
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('客户端目录路径不能包含上级目录回溯（..）');
    segments.push(segment);
  }
  return segments.length ? `/${segments.join('/')}` : '/';
}

function hitsProtectedTarget(candidate: string, protectedRoots: readonly string[]): boolean {
  if (candidate === '/') return true;
  for (const prefix of RESERVED_VM_PREFIXES) {
    if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
  }
  for (const root of protectedRoots) {
    if (!root || !posix.isAbsolute(root)) continue;
    const cleanRoot = stripTrailingPosixSlashes(root);
    if (cleanRoot === '/') continue;
    if (candidate === cleanRoot || candidate.startsWith(`${cleanRoot}/`) || cleanRoot.startsWith(`${candidate}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Computes the mount target path inside a slot VM for Mode 2 (`mirrored`) client projects.
 * - Windows: `C:\Users\80118\proj` -> `/c/Users/80118/proj`.
 * - macOS / Linux: preserves original path unless it collides with reserved Linux prefixes or protected Hub roots.
 */
export function vmTargetPath(
  platform: string,
  remotePath: string,
  fallbackLocalPath: string,
  protectedRoots: readonly string[] = [],
): string {
  const kind = normalizePlatform(platform);
  const normalized = assertClientPath(kind, remotePath);
  let candidate: string;
  if (kind === 'windows') {
    const drive = normalized[0]!.toLowerCase();
    const tail = normalized.slice(3).replace(/\\/g, '/').replace(/\/+$/, '');
    candidate = tail ? `/${drive}/${tail}` : `/${drive}`;
  } else {
    candidate = stripTrailingPosixSlashes(normalized);
  }
  if (hitsProtectedTarget(candidate, protectedRoots)) {
    return stripTrailingPosixSlashes(fallbackLocalPath);
  }
  return candidate;
}

function parseWindowsComparable(value: string): { drive: string; segments: string[] } | undefined {
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (driveMatch) {
    const segments = driveMatch[2]!.split(/[\\/]+/).filter(s => s && s !== '.');
    return { drive: driveMatch[1]!.toLowerCase(), segments };
  }
  const posixDriveMatch = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value);
  if (posixDriveMatch) {
    const segments = (posixDriveMatch[2] ?? '').split('/').filter(s => s && s !== '.');
    return { drive: posixDriveMatch[1]!.toLowerCase(), segments };
  }
  return undefined;
}

function matchWindowsPrefix(root: string, candidate: string): string[] | undefined {
  const parsedRoot = parseWindowsComparable(root);
  const parsedCandidate = parseWindowsComparable(candidate);
  if (!parsedRoot || !parsedCandidate || parsedRoot.drive !== parsedCandidate.drive) return undefined;
  if (parsedCandidate.segments.length < parsedRoot.segments.length) return undefined;
  for (let i = 0; i < parsedRoot.segments.length; i++) {
    if (parsedRoot.segments[i]!.toLowerCase() !== parsedCandidate.segments[i]!.toLowerCase()) return undefined;
  }
  return parsedCandidate.segments.slice(parsedRoot.segments.length);
}

function joinClientPath(platform: ClientPlatform, clientRoot: string, relSegments: string[]): string {
  if (platform === 'windows') {
    const cleanRoot = assertClientPath('windows', clientRoot);
    if (!relSegments.length) return cleanRoot;
    return cleanRoot.endsWith('\\') ? `${cleanRoot}${relSegments.join('\\')}` : `${cleanRoot}\\${relSegments.join('\\')}`;
  }
  const cleanRoot = stripTrailingPosixSlashes(assertClientPath(platform, clientRoot));
  if (!relSegments.length) return cleanRoot;
  return cleanRoot === '/' ? `/${relSegments.join('/')}` : `${cleanRoot}/${relSegments.join('/')}`;
}

/** Maps a client-side absolute path inside `clientRoot` to its VM path under `vmRoot`. */
export function clientToVmPath(platform: string, vmRoot: string, clientRoot: string, inputPath: string): string {
  const kind = normalizePlatform(platform);
  const cleanVmRoot = stripTrailingPosixSlashes(vmRoot);
  if (kind === 'windows') {
    const rel = matchWindowsPrefix(clientRoot, inputPath);
    if (!rel) return inputPath;
    return rel.length ? `${cleanVmRoot}/${rel.join('/')}` : cleanVmRoot;
  }
  const cleanClientRoot = stripTrailingPosixSlashes(clientRoot);
  const cleanInput = stripTrailingPosixSlashes(inputPath);
  if (cleanInput === cleanClientRoot) return cleanVmRoot;
  const prefix = cleanClientRoot === '/' ? '/' : `${cleanClientRoot}/`;
  if (!cleanInput.startsWith(prefix)) return inputPath;
  const rel = cleanInput.slice(prefix.length);
  return cleanVmRoot === '/' ? `/${rel}` : `${cleanVmRoot}/${rel}`;
}

/** Maps a VM/local path under `vmRoot` back to the corresponding absolute path on the client host. */
export function vmToClientPath(platform: string, vmRoot: string, clientRoot: string, inputPath: string): string {
  const kind = normalizePlatform(platform);
  const cleanVmRoot = stripTrailingPosixSlashes(vmRoot);
  if (kind === 'windows') {
    const cleanInputPosix = inputPath.replace(/\\/g, '/');
    const normalizedInput = cleanInputPosix.startsWith('/') ? stripTrailingPosixSlashes(cleanInputPosix) : cleanInputPosix;
    if (normalizedInput.toLowerCase() === cleanVmRoot.toLowerCase()) {
      return joinClientPath('windows', clientRoot, []);
    }
    const prefix = `${cleanVmRoot}/`;
    if (normalizedInput.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rel = normalizedInput.slice(prefix.length).split('/').filter(Boolean);
      return joinClientPath('windows', clientRoot, rel);
    }
    const winRel = matchWindowsPrefix(clientRoot, inputPath);
    if (winRel) return joinClientPath('windows', clientRoot, winRel);
    return inputPath;
  }
  const cleanInput = stripTrailingPosixSlashes(inputPath);
  if (cleanInput === cleanVmRoot) return joinClientPath(kind, clientRoot, []);
  const prefix = cleanVmRoot === '/' ? '/' : `${cleanVmRoot}/`;
  if (!cleanInput.startsWith(prefix)) return inputPath;
  const rel = cleanInput.slice(prefix.length).split('/').filter(Boolean);
  return joinClientPath(kind, clientRoot, rel);
}

/** Rewrites occurrences of a VM or local mirror root inside a shell command into the client host's root path. */
export function rewriteCommandPaths(platform: string, roots: readonly string[], clientRoot: string, command: string): string {
  const kind = normalizePlatform(platform);
  const normalizedClient = assertClientPath(kind, clientRoot);
  let output = command;
  const uniqueRoots = [...new Set(roots.filter(Boolean).map(stripTrailingPosixSlashes))]
    .sort((a, b) => b.length - a.length);
  for (const root of uniqueRoots) {
    if (root === normalizedClient || root === '/') continue;
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}(?=/|[\\s"'\\x60;:,|&()<>]|$)`, 'g');
    output = output.replace(pattern, () => normalizedClient);
  }
  return output;
}

/** Normalizes and validates a project-relative POSIX path used in client RPC calls. */
export function normalizeRelativePath(
  rawPath: string | undefined,
  options: { allowEmpty?: boolean; allowInternal?: boolean; platform?: string } = {},
): string {
  const value = (rawPath ?? '').trim();
  if (!value || value === '.') {
    if (options.allowEmpty) return '';
    throw new Error('相对路径不能为空');
  }
  if (value.startsWith('/') || value.includes('\\') || /[\0-\x1f\x7f]/.test(value) || value.length > MAX_PATH_LENGTH) {
    throw new Error('相对路径格式无效');
  }
  const segments = value.split('/').filter(Boolean);
  if (!segments.length) {
    if (options.allowEmpty) return '';
    throw new Error('相对路径不能为空');
  }
  const isWindows = options.platform !== undefined && normalizePlatform(options.platform) === 'windows';
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw new Error('路径不能包含 . 或 ..');
    if (isWindows && segment.includes(':')) throw new Error(`Windows 相对路径段不能包含冒号：${segment}`);
    if (!options.allowInternal && isProtectedInternalSegment(segment)) {
      throw new Error('无法访问运行时内部或 Git 目录');
    }
  }
  return segments.join('/');
}

/**
 * Validates that a project-relative filename/path is portable to the target client filesystem.
 * - Windows (NTFS): rejects `< > : " \ | ? *`, control chars `< 0x20`, trailing spaces/dots, and reserved DOS device names.
 * - Windows & macOS (NTFS / APFS): rejects case-only collisions against `existingSiblings` in the same directory.
 */
export function assertPortableFilename(platform: string, relPath: string, existingSiblings?: Iterable<string>): void {
  const kind = normalizePlatform(platform);
  if (!relPath || relPath.startsWith('/') || relPath.endsWith('/') || relPath.includes('\0')) {
    throw new Error(`文件名路径无效：${relPath}`);
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`路径段无效：${relPath}`);
    }
    if (isProtectedInternalSegment(segment)) {
      throw new Error(`不能写入受保护的内部或 Git 目录：${relPath}`);
    }
    if (kind === 'windows') {
      if (WINDOWS_ILLEGAL_CHARS.test(segment)) {
        throw new Error(`Windows 文件名包含非法字符：${relPath}`);
      }
      if (segment.endsWith(' ') || segment.endsWith('.')) {
        throw new Error(`Windows 文件名不能以空格或点号结尾：${relPath}`);
      }
      const stem = segment.split('.')[0] ?? '';
      if (WINDOWS_RESERVED_NAMES.test(stem)) {
        throw new Error(`Windows 保留设备名不可用作文件名：${relPath}`);
      }
    } else if (/[\0]/.test(segment)) {
      throw new Error(`文件名包含非法字符：${relPath}`);
    }
  }
  if (existingSiblings && (kind === 'windows' || kind === 'macos')) {
    const leaf = segments.at(-1)!;
    const lowerLeaf = leaf.toLowerCase();
    for (const sibling of existingSiblings) {
      if (sibling !== leaf && sibling.toLowerCase() === lowerLeaf) {
        throw new Error(`目标系统不区分文件名大小写，存在重名冲突：${leaf} 与 ${sibling}`);
      }
    }
  }
}
