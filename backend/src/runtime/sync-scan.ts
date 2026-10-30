import { gunzipSync } from 'node:zlib';
import { SshManager } from './ssh.js';
import { DEFAULT_IGNORES, IGNORE_FILE, IGNORE_FILES, IGNORE_FILE_LIMIT, literalIgnore, loadSyncPolicy } from './sync-policy.js';
import { assertRemotePath, shellQuote, type DevHost, type RuntimeConfig } from './types.js';

const OUTPUT_LIMIT = 64 * 1024 * 1024;
const MIN_ENTRY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 15;
const MAX_PRUNED_PATHS = 2000;

export interface SyncScanEntry {
  path: string;
  type: 'directory' | 'file';
  bytes: number;
  files: number;
  // Whether Git tracks the file, or any file inside the directory; null outside Git work trees.
  tracked: boolean | null;
}

export interface SyncScan {
  remotePath: string;
  totalBytes: number;
  totalFiles: number;
  entries: SyncScanEntry[];
  truncated: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function componentSource(component: string): string {
  let source = '';
  for (let index = 0; index < component.length; index++) {
    const character = component[index]!;
    if (character === '\\' && index + 1 < component.length) source += escapeRegex(component[++index]!);
    else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '[') {
      const end = component.indexOf(']', index + 2);
      if (end < 0) { source += '\\['; continue; }
      let body = component.slice(index + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      source += `[${negated ? '^/' : ''}${body.replace(/[\\\]\[^]/g, '\\$&')}]`;
      index = end;
    } else if (character === '{') {
      const end = component.indexOf('}', index);
      if (end < 0) { source += '\\{'; continue; }
      source += `(?:${component.slice(index + 1, end).split(',').map(componentSource).join('|')})`;
      index = end;
    } else source += escapeRegex(character);
  }
  return source;
}

// Converts a doublestar pattern, as used by Mutagen, into an anchored regular expression.
function globSource(pattern: string): string {
  const components = pattern.split('/');
  let source = '';
  components.forEach((component, index) => {
    const last = index === components.length - 1;
    if (component === '**') {
      if (index === 0) source += last ? '.*' : '(?:[^/]+/)*';
      else source += last ? '(?:/.*)?' : '(?:/[^/]+)*';
      return;
    }
    if (index > 0 && !(index === 1 && components[0] === '**')) source += '/';
    source += componentSource(component);
  });
  return `^${source}$`;
}

interface Rule { index: number; regex: RegExp; negated: boolean; directoryOnly: boolean; leaf: boolean }

// Estimates Mutagen's ignore decisions: the last matching pattern wins and ignored directories hide their contents.
export class IgnoreMatcher {
  private readonly literals = new Map<string, number>();
  private readonly rules: Rule[] = [];
  private readonly directories = new Map<string, boolean>();

  constructor(patterns: string[]) {
    patterns.forEach((raw, index) => {
      let pattern = raw;
      const negated = pattern.startsWith('!');
      if (negated) pattern = pattern.slice(1);
      const absolute = pattern.startsWith('/');
      if (absolute) pattern = pattern.slice(1);
      const directoryOnly = pattern.endsWith('/');
      if (directoryOnly) pattern = pattern.slice(0, -1);
      if (!pattern) return;
      // Literal anchored paths, such as Git-ignored entries, can number in the thousands.
      if (absolute && !negated && !directoryOnly && !/(?<!\\)[*?[{]/.test(pattern)) {
        this.literals.set(pattern.replace(/\\(.)/g, '$1'), index);
        return;
      }
      this.rules.push({ index, regex: new RegExp(globSource(pattern)), negated, directoryOnly,
        leaf: !absolute && !pattern.includes('/') });
    });
  }

  private own(path: string, directory: boolean): boolean {
    let best = this.literals.get(path) ?? -1;
    const name = path.slice(path.lastIndexOf('/') + 1);
    for (let index = this.rules.length - 1; index >= 0; index--) {
      const rule = this.rules[index]!;
      if (rule.index < best) break;
      if (rule.directoryOnly && !directory) continue;
      if (rule.regex.test(path) || (rule.leaf && rule.regex.test(name))) return !rule.negated;
    }
    return best >= 0;
  }

  private directoryIgnored(path: string): boolean {
    let ignored = this.directories.get(path);
    if (ignored === undefined) {
      const parent = path.lastIndexOf('/');
      ignored = (parent > 0 && this.directoryIgnored(path.slice(0, parent))) || this.own(path, true);
      this.directories.set(path, ignored);
    }
    return ignored;
  }

  ignored(path: string, directory = false): boolean {
    const parent = path.lastIndexOf('/');
    if (parent > 0 && this.directoryIgnored(path.slice(0, parent))) return true;
    return directory ? this.directoryIgnored(path) : this.own(path, false);
  }
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) result.push(path.slice(0, slash));
  return result;
}

function findPattern(path: string): string {
  return `./${path.replace(/\/$/, '').replace(/[\\*?[\]]/g, '\\$&')}`;
}

// Lists remote file sizes once, before the first sync, so users can exclude the largest outputs.
export async function scanSyncCandidates(config: RuntimeConfig, ssh: SshManager, userId: string, host: DevHost, remotePath: string): Promise<SyncScan> {
  assertRemotePath(remotePath);
  const policy = await loadSyncPolicy(config, ssh, userId, host, remotePath);
  // Pruning remotely keeps dependency trees and Git-ignored directories out of the listing.
  const names = ['.git', ...DEFAULT_IGNORES.filter(pattern => /^[^!/*?[{\\]+$/.test(pattern))];
  const prunes = [
    ...names.map(name => `-name ${shellQuote(name)}`),
    ...policy.archivePaths.slice(0, MAX_PRUNED_PATHS).map(path => `-path ${shellQuote(findPattern(path))}`),
  ].join(' -o ');
  const result = await ssh.exec(userId, host, [
    `cd -- ${shellQuote(policy.remotePath)} || exit`,
    `command -v gzip >/dev/null && command -v base64 >/dev/null || { echo '远端缺少 gzip 或 base64' >&2; exit 3; }`,
    `find . -maxdepth 0 -printf '' 2>/dev/null || { echo '远端 find 不支持 -printf，需要 GNU findutils' >&2; exit 3; }`,
    `find . \\( ${prunes} \\) -prune -o -type f -printf '%s\\t%P\\0' 2>/dev/null | head -c ${OUTPUT_LIMIT} | gzip -1c | base64`,
  ].join('\n'), 180_000, 64 * 1024 * 1024);
  if (result.code !== 0) throw new Error(`远端体积扫描失败：${result.stderr.trim() || `退出码 ${result.code}`}`);
  const raw = gunzipSync(Buffer.from(result.stdout, 'base64'));
  const truncated = raw.length >= OUTPUT_LIMIT;
  const records = raw.toString('utf8').split('\0');
  // The trailing element is empty, or a partial record when the listing was cut off.
  records.pop();

  const matcher = new IgnoreMatcher(policy.ignores);
  const directories = new Map<string, { bytes: number; files: number }>();
  const largeFiles: { path: string; bytes: number }[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const record of records) {
    const tab = record.indexOf('\t');
    const bytes = Number(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (tab < 0 || !Number.isFinite(bytes) || !path || matcher.ignored(path)) continue;
    totalBytes += bytes;
    totalFiles++;
    if (bytes >= MIN_ENTRY_BYTES) largeFiles.push({ path, bytes });
    for (const directory of ancestors(path)) {
      const usage = directories.get(directory) ?? { bytes: 0, files: 0 };
      usage.bytes += bytes;
      usage.files++;
      directories.set(directory, usage);
    }
  }

  const untrackedDirectories = new Set(policy.untracked?.filter(path => path.endsWith('/')).map(path => path.slice(0, -1)));
  const untrackedFiles = new Set(policy.untracked?.filter(path => !path.endsWith('/')));
  const tracked = (path: string, directory: boolean): boolean | null => {
    if (!policy.untracked) return null;
    if ((directory ? untrackedDirectories : untrackedFiles).has(path)) return false;
    return !ancestors(path).some(parent => untrackedDirectories.has(parent));
  };
  const candidates: SyncScanEntry[] = [
    ...[...directories].filter(([, usage]) => usage.bytes >= MIN_ENTRY_BYTES)
      .map(([path, usage]) => ({ path, type: 'directory' as const, ...usage, tracked: tracked(path, true) })),
    ...largeFiles.map(({ path, bytes }) => ({ path, type: 'file' as const, bytes, files: 1, tracked: tracked(path, false) })),
  ].filter(entry => !entry.path.includes('�') && !IGNORE_FILES.includes(entry.path))
    .sort((left, right) => right.bytes - left.bytes
      || left.path.split('/').length - right.path.split('/').length
      || (left.type === right.type ? 0 : left.type === 'directory' ? -1 : 1));

  const chosen = new Set<string>();
  const entries: SyncScanEntry[] = [];
  for (const entry of candidates) {
    if (entries.length >= MAX_ENTRIES) break;
    // Directories holding tracked source are split into their untracked or large parts instead.
    if (entry.type === 'directory' && entry.tracked) continue;
    if (ancestors(entry.path).some(parent => chosen.has(parent))) continue;
    entries.push(entry);
    if (entry.type === 'directory') chosen.add(entry.path);
  }
  return { remotePath: policy.remotePath, totalBytes, totalFiles, entries, truncated };
}

export function assertIgnorePath(path: string): void {
  if (path.length > 4096 || /[\0\r\n]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('排除路径必须是项目内的相对路径');
  }
}

// Appends literal, root-anchored rules so that later edits by users remain ordinary text lines.
export async function appendIgnoreRules(ssh: SshManager, userId: string, host: DevHost, remotePath: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  assertRemotePath(remotePath);
  paths.forEach(assertIgnorePath);
  const lines = [`# 由 Clinavat 在首次同步前添加（${new Date().toISOString().slice(0, 10)}）`, ...paths.map(literalIgnore)];
  if (Buffer.byteLength(lines.join('\n')) > IGNORE_FILE_LIMIT) throw new Error(`${IGNORE_FILE} 超过 64 KiB`);
  const file = shellQuote(IGNORE_FILE);
  const result = await ssh.exec(userId, host, [
    `cd -- ${shellQuote(remotePath)} || exit`,
    // Rename the highest-precedence legacy file only; older rules stay before it and an existing new file is never replaced.
    `if [ ! -e ${file} ] && [ ! -L ${file} ]; then`,
    `  for legacy_file in ${IGNORE_FILES.slice(0, -1).reverse().map(shellQuote).join(' ')}; do`,
    `    if [ -e "$legacy_file" ] || [ -L "$legacy_file" ]; then`,
    `      if [ -f "$legacy_file" ] && [ ! -L "$legacy_file" ]; then mv -nT -- "$legacy_file" ${file} || exit; fi`,
    `      break`,
    `    fi`,
    `  done`,
    `fi`,
    `if [ -L ${file} ] || { [ -e ${file} ] && [ ! -f ${file} ]; }; then echo '${IGNORE_FILE} 必须是普通文件' >&2; exit 3; fi`,
    `if [ -s ${file} ] && [ -n "$(tail -c 1 -- ${file})" ]; then printf '\\n' >> ${file} || exit; fi`,
    `printf '%s\\n' ${lines.map(shellQuote).join(' ')} >> ${file}`,
  ].join('\n'));
  if (result.code !== 0) throw new Error(`无法写入 ${IGNORE_FILE}：${result.stderr.trim() || `退出码 ${result.code}`}`);
}
