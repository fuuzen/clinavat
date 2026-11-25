import { gunzipSync } from 'node:zlib';
import { SshManager } from './ssh.js';
import { DEFAULT_IGNORES, loadSyncPolicy } from './sync-policy.js';
import { assertRemotePath, shellQuote, type DevHost, type RuntimeConfig } from './types.js';

const OUTPUT_LIMIT = 64 * 1024 * 1024;
const MIN_ENTRY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 15;
const MAX_PRUNED_PATHS = 2000;
const MAX_LINKS = 200;

export interface SyncScanEntry {
  path: string;
  type: 'directory' | 'file';
  bytes: number;
  files: number;
  // Whether Git tracks the file, or any file inside the directory; null outside Git work trees.
  tracked: boolean | null;
}

/**
 * A symbolic link Mutagen will skip. `project`: an absolute target inside the project; `workspace`: an absolute
 * target under Clinavat's workspace path, left by a build in an earlier project; `outside`: a target outside the
 * project; `invalid`: an empty target, or one with a colon or backslash.
 */
export interface SyncScanLink {
  path: string;
  target: string;
  kind: 'project' | 'workspace' | 'outside' | 'invalid';
}

export interface SyncScan {
  remotePath: string;
  totalBytes: number;
  totalFiles: number;
  entries: SyncScanEntry[];
  links: SyncScanLink[];
  linkCount: number;
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

// Mirrors Mutagen's portable symbolic link checks, which accept only relative targets that stay inside the project.
function unsyncableLink(path: string, target: string, remoteRoot: string, workspaceDir: string): SyncScanLink['kind'] | undefined {
  if (!target || target.includes(':') || target.includes('\\')) return 'invalid';
  if (target.startsWith('/')) {
    if (target === remoteRoot || target.startsWith(`${remoteRoot}/`)) return 'project';
    return target.startsWith(`${workspaceDir}/`) ? 'workspace' : 'outside';
  }
  let depth = path.split('/').length - 1;
  for (const part of target.split('/')) {
    if (part === '..') { if (--depth < 0) return 'outside'; }
    else if (part && part !== '.') depth++;
  }
  return undefined;
}

const PERL_SCAN_SCRIPT = String.raw`use strict;
use warnings;
binmode STDIN;
binmode STDOUT;
my $limit = $ARGV[0] + 0;
my (%prune_name, %prune_path);
{
  local $/ = "\0";
  while (defined(my $kind = <STDIN>)) {
    chomp $kind;
    my $val = <STDIN>;
    last unless defined $val;
    chomp $val;
    if ($kind eq "n") { $prune_name{$val} = 1; }
    elsif ($kind eq "p") { $prune_path{$val} = 1; }
  }
}
my $written = 0;
my @stack = ("");
while (@stack) {
  my $prefix = pop @stack;
  my $dir = $prefix eq "" ? "." : "./$prefix";
  opendir(my $dh, $dir) or next;
  while (defined(my $entry = readdir($dh))) {
    next if $entry eq "." || $entry eq "..";
    my $rel = $prefix eq "" ? $entry : "$prefix/$entry";
    next if $prune_name{$entry} || $prune_path{$rel};
    my $fs = "./$rel";
    my @st = lstat($fs) or next;
    my $rec;
    if (-l _) {
      my $target = readlink($fs);
      next unless defined $target;
      $rec = "l\0$target\0$rel\0";
    } elsif (-f _) {
      $rec = "f\0$st[7]\0$rel\0";
    } elsif (-d _) {
      push @stack, $rel;
      next;
    } else {
      next;
    }
    my $len = length($rec);
    if ($written + $len >= $limit) {
      print STDOUT substr($rec, 0, $limit - $written);
      exit 0;
    }
    print STDOUT $rec;
    $written += $len;
  }
  closedir($dh);
}
`;

const PYTHON_SCAN_SCRIPT = String.raw`import os, sys

limit = int(sys.argv[1])
data = sys.stdin.buffer.read().split(b'\0')
prune_names = set()
prune_paths = set()
for i in range(0, len(data) - 1, 2):
    kind = data[i]
    val = data[i + 1]
    if kind == b'n':
        prune_names.add(val)
    elif kind == b'p':
        prune_paths.add(val)

out = sys.stdout.buffer
written = 0
stack = [b'']
while stack:
    prefix = stack.pop()
    dir_path = b'.' if not prefix else b'./' + prefix
    try:
        it = os.scandir(dir_path)
    except OSError:
        continue
    try:
        with it:
            for entry in it:
                name = entry.name
                rel = name if not prefix else prefix + b'/' + name
                if name in prune_names or rel in prune_paths:
                    continue
                try:
                    if entry.is_symlink():
                        target = os.readlink(entry.path)
                        rec = b'l\0' + target + b'\0' + rel + b'\0'
                    elif entry.is_file(follow_symlinks=False):
                        size = entry.stat(follow_symlinks=False).st_size
                        rec = b'f\0' + str(size).encode('ascii') + b'\0' + rel + b'\0'
                    elif entry.is_dir(follow_symlinks=False):
                        stack.append(rel)
                        continue
                    else:
                        continue
                except OSError:
                    continue
                n = len(rec)
                if written + n >= limit:
                    out.write(rec[:limit - written])
                    out.flush()
                    sys.exit(0)
                out.write(rec)
                written += n
    except OSError:
        continue
out.flush()
`;

function buildRemoteScanScript(remotePath: string, pruneNames: string[], prunePaths: string[]): string {
  return [
    `cd -- ${shellQuote(remotePath)} || exit`,
    // Prefer /usr/bin tools so Windows Git Bash does not pick System32 utilities over MSYS2 coreutils/findutils.
    `pick_tool() {`,
    `  local c`,
    `  for c in "$@"; do`,
    `    case "$c" in`,
    `      */*) [ -x "$c" ] && { printf '%s' "$c"; return 0; } ;;`,
    `      *) command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; } ;;`,
    `    esac`,
    `  done`,
    `  return 1`,
    `}`,
    `GZIP_BIN="$(pick_tool /usr/bin/gzip gzip || true)"`,
    `BASE64_BIN="$(pick_tool /usr/bin/base64 base64 || true)"`,
    `HEAD_BIN="$(pick_tool /usr/bin/head head || true)"`,
    `[ -n "$GZIP_BIN" ] && [ -n "$BASE64_BIN" ] || { echo '远端缺少 gzip 或 base64' >&2; exit 3; }`,
    `PRUNE_NAMES=(${pruneNames.map(shellQuote).join(' ')})`,
    `PRUNE_PATHS=(${prunePaths.map(shellQuote).join(' ')})`,
    `escape_find_path() {`,
    `  local s="$1" i ch`,
    `  ESCAPED_PATH='./'`,
    `  for ((i=0; i<\${#s}; i++)); do`,
    `    ch="\${s:i:1}"`,
    `    case "$ch" in`,
    `      \\\\|\\*|\\?|\\[|\\]) ESCAPED_PATH="\${ESCAPED_PATH}\\\\\${ch}" ;;`,
    `      *) ESCAPED_PATH="\${ESCAPED_PATH}\${ch}" ;;`,
    `    esac`,
    `  done`,
    `}`,
    `emit_prunes() {`,
    `  local n p`,
    `  if [ "\${#PRUNE_NAMES[@]}" -gt 0 ]; then`,
    `    for n in "\${PRUNE_NAMES[@]}"; do printf 'n\\000%s\\000' "$n"; done`,
    `  fi`,
    `  if [ "\${#PRUNE_PATHS[@]}" -gt 0 ]; then`,
    `    for p in "\${PRUNE_PATHS[@]}"; do printf 'p\\000%s\\000' "$p"; done`,
    `  fi`,
    `}`,
    `FIND_BIN=""`,
    `if [ -n "$HEAD_BIN" ]; then`,
    `  for c in /usr/bin/find gfind /opt/homebrew/bin/gfind /usr/local/bin/gfind find; do`,
    `    bin=""`,
    `    case "$c" in`,
    `      */*) [ -x "$c" ] && bin="$c" ;;`,
    `      *) bin="$(command -v "$c" 2>/dev/null || true)" ;;`,
    `    esac`,
    `    if [ -n "$bin" ] && "$bin" . -maxdepth 0 -printf '' </dev/null >/dev/null 2>&1; then`,
    `      FIND_BIN="$bin"`,
    `      break`,
    `    fi`,
    `  done`,
    `fi`,
    `if [ -n "$FIND_BIN" ]; then`,
    `  FIND_PRUNES=()`,
    `  if [ "\${#PRUNE_NAMES[@]}" -gt 0 ]; then`,
    `    for n in "\${PRUNE_NAMES[@]}"; do`,
    `      [ "\${#FIND_PRUNES[@]}" -gt 0 ] && FIND_PRUNES+=(-o)`,
    `      FIND_PRUNES+=(-name "$n")`,
    `    done`,
    `  fi`,
    `  if [ "\${#PRUNE_PATHS[@]}" -gt 0 ]; then`,
    `    for p in "\${PRUNE_PATHS[@]}"; do`,
    `      [ "\${#FIND_PRUNES[@]}" -gt 0 ] && FIND_PRUNES+=(-o)`,
    `      case "$p" in`,
    `        *\\\\*|*\\**|*\\?*|*\\[*|*\\]*)`,
    `          escape_find_path "$p"`,
    `          FIND_PRUNES+=(-path "$ESCAPED_PATH")`,
    `          ;;`,
    `        *) FIND_PRUNES+=(-path "./$p") ;;`,
    `      esac`,
    `    done`,
    `  fi`,
    `  "$FIND_BIN" . '(' "\${FIND_PRUNES[@]}" ')' -prune -o -type f -printf 'f\\0%s\\0%P\\0' -o -type l -printf 'l\\0%l\\0%P\\0' 2>/dev/null | "$HEAD_BIN" -c ${OUTPUT_LIMIT} | "$GZIP_BIN" -1c | "$BASE64_BIN"`,
    `  exit`,
    `fi`,
    // macOS bundles /usr/bin/perl natively without triggering Xcode CLT installation prompts.
    `PERL_BIN="$(pick_tool /usr/bin/perl perl || true)"`,
    `if [ -n "$PERL_BIN" ] && "$PERL_BIN" -e 'exit 0' </dev/null >/dev/null 2>&1; then`,
    `  emit_prunes | "$PERL_BIN" -e ${shellQuote(PERL_SCAN_SCRIPT)} -- ${OUTPUT_LIMIT} | "$GZIP_BIN" -1c | "$BASE64_BIN"`,
    `  exit`,
    `fi`,
    `PYTHON_BIN="$(pick_tool /usr/bin/python3 python3 || true)"`,
    `if [ -n "$PYTHON_BIN" ] && "$PYTHON_BIN" -c 'import os,sys' </dev/null >/dev/null 2>&1; then`,
    `  emit_prunes | "$PYTHON_BIN" -c ${shellQuote(PYTHON_SCAN_SCRIPT)} ${OUTPUT_LIMIT} | "$GZIP_BIN" -1c | "$BASE64_BIN"`,
    `  exit`,
    `fi`,
    `echo '远端缺少可用的目录扫描工具（需要 GNU find、perl 或 python3）' >&2`,
    `exit 3`,
  ].join('\n');
}

// Lists remote file sizes and symbolic links once, before the first sync, so users can exclude the largest outputs
// and see which links will not sync.
export async function scanSyncCandidates(config: RuntimeConfig, ssh: SshManager, userId: string, host: DevHost, remotePath: string, rules: string): Promise<SyncScan> {
  assertRemotePath(remotePath);
  const policy = await loadSyncPolicy(config, ssh, userId, host, remotePath, rules);
  // Pruning remotely keeps dependency trees and Git-ignored directories out of the listing.
  const pruneNames = ['.git', ...DEFAULT_IGNORES.filter(pattern => /^[^!/*?[{\\]+$/.test(pattern))];
  const prunePaths = policy.archivePaths
    .slice(0, MAX_PRUNED_PATHS)
    .map(path => path.replace(/\/$/, ''))
    .filter(Boolean);
  const result = await ssh.exec(
    userId,
    host,
    buildRemoteScanScript(policy.remotePath, pruneNames, prunePaths),
    180_000,
    64 * 1024 * 1024,
  );
  if (result.code !== 0) throw new Error(`远端体积扫描失败：${result.stderr.trim() || `退出码 ${result.code}`}`);
  const raw = gunzipSync(Buffer.from(result.stdout, 'base64'));
  const truncated = raw.length >= OUTPUT_LIMIT;
  // Each record is three NUL-terminated fields: type, size or link target, and path.
  const fields = raw.toString('utf8').split('\0');
  // The trailing element is empty, or part of a record when the listing was cut off.
  const recordCount = Math.floor((fields.length - 1) / 3);

  const matcher = new IgnoreMatcher(policy.ignores);
  const directories = new Map<string, { bytes: number; files: number }>();
  const largeFiles: { path: string; bytes: number }[] = [];
  const links: SyncScanLink[] = [];
  let linkCount = 0;
  let totalBytes = 0;
  let totalFiles = 0;
  for (let record = 0; record < recordCount; record++) {
    const [type, value, path] = fields.slice(record * 3, record * 3 + 3) as [string, string, string];
    if (!path || matcher.ignored(path)) continue;
    if (type === 'l') {
      const kind = unsyncableLink(path, value, policy.remotePath, config.workspaceDir);
      if (kind && ++linkCount <= MAX_LINKS) links.push({ path, target: value, kind });
      continue;
    }
    const bytes = Number(value);
    if (type !== 'f' || !Number.isFinite(bytes)) continue;
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
  ].filter(entry => !entry.path.includes('�'))
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
  return { remotePath: policy.remotePath, totalBytes, totalFiles, entries, links, linkCount, truncated };
}

export function assertIgnorePath(path: string): void {
  if (path.length > 4096 || /[\0\r\n]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('排除路径必须是项目内的相对路径');
  }
}
