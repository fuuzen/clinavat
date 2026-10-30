import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { SshManager } from './ssh.js';
import { shellQuote, type DevHost, type RuntimeConfig } from './types.js';

export const DEFAULT_IGNORES = [
  'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.nuxt',
  '.cache', 'coverage', '/.bin', '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  '*.log', '*.log.*', '*.pyc', '*.pyo', '*.o', '*.so', '*.so.*', '*.a', '*.zip', '*.tar', '*.gz',
  '*.tgz', '*.bz2', '*.xz', '*.zst', '*.7z', '*.rar', '*.mp4', '*.mov', '*.iso',
  '*.sqlite', '*.sqlite-*', '*.sqlite3', '*.sqlite3-*', '*.db', '*.db-wal', '*.db-shm',
  '*.tsbuildinfo', '.DS_Store',
];

export const IGNORE_FILE = '.clinavatignore';
// Later files retain precedence, including ! rules from existing projects.
export const IGNORE_FILES = ['.cc-poolignore', '.cc-pool-ignore', IGNORE_FILE];
export const IGNORE_FILE_LIMIT = 65536;

export interface SyncPolicy {
  remotePath: string; ignores: string[]; archivePaths: string[]; fingerprint: string;
  // Untracked paths reported by Git; null outside Git work trees. Directories end with '/'.
  untracked: string[] | null;
}

export function literalIgnore(path: string): string {
  return '/' + path.replace(/\/$/, '').replace(/[\\*?\[\]]/g, character => `\\${character}`);
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function loadSyncPolicy(config: RuntimeConfig, ssh: SshManager, userId: string, host: DevHost, remotePath: string): Promise<SyncPolicy> {
  const dataRoot = await realpath(config.dataDir);
  const token = randomUUID();
  const marker = join(dataRoot, `.sync-origin-${token}`);
  await writeFile(marker, token, { mode: 0o600, flag: 'wx' });
  let output: string;
  try {
    const result = await ssh.exec(userId, host, [
      `cd -- ${shellQuote(remotePath)} || exit`,
      `printf '%s\\0' "$(pwd -P)"`,
      `if [ "$(cat -- ${shellQuote(marker)} 2>/dev/null)" = ${shellQuote(token)} ]; then printf 'same-host'; fi`,
      `printf '\\0'`,
      ...IGNORE_FILES.map(name =>
        `if [ -f ${name} ]; then head -c ${IGNORE_FILE_LIMIT + 1} -- ${name} || exit; fi; printf '\\0'`),
      `if command -v git >/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
      `  printf 'git\\0'`,
      `  git --no-optional-locks -c status.renames=false status --porcelain=v1 --ignored=matching --untracked-files=normal -z || exit`,
      `fi`,
    ].join('\n'));
    if (result.code !== 0) throw new Error(`无法读取项目同步排除规则：${result.stderr.trim() || '远端命令失败'}`);
    output = result.stdout;
  } finally { await rm(marker, { force: true }); }

  const [remoteRoot, sameHost, ...entries] = output.split('\0');
  const customRules = entries.slice(0, IGNORE_FILES.length);
  const [git, ...gitEntries] = entries.slice(IGNORE_FILES.length);
  if (!remoteRoot?.startsWith('/')) throw new Error('无法确定远端项目的真实目录');
  customRules.forEach((contents, index) => {
    if (Buffer.byteLength(contents) > IGNORE_FILE_LIMIT) throw new Error(`${IGNORE_FILES[index]} 超过 64 KiB`);
  });
  const ignores = [...DEFAULT_IGNORES];
  // Matching mode traverses untracked parents too, while collapsing explicitly ignored output directories.
  const gitIgnored = gitEntries.filter(entry => entry.startsWith('!! ')).map(entry => entry.slice(3));
  const archivePaths = [...gitIgnored];
  ignores.push(...gitIgnored.sort().map(literalIgnore));
  ignores.push(...customRules.join('\n').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  if (sameHost) {
    if (inside(dataRoot, remoteRoot)) throw new Error('不能将平台运行数据或已有镜像创建为项目，请选择源码目录');
    if (inside(config.workspaceDir, remoteRoot)) throw new Error('不能将号池机本地镜像当成远端源码目录');
    for (const internal of [dataRoot, config.workspaceDir]) if (inside(remoteRoot, internal)) {
      const path = relative(remoteRoot, internal);
      ignores.push(literalIgnore(path));
      archivePaths.push(path);
    }
  }
  // Project rules cannot expose the executor or local environment credentials.
  ignores.push('/.bin', '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template');
  const unique = [...new Set(ignores.reverse())].reverse();
  const untracked = git === 'git' ? gitEntries.filter(entry => entry.startsWith('?? ')).map(entry => entry.slice(3)) : null;
  return { remotePath: remoteRoot, ignores: unique, archivePaths, untracked,
    fingerprint: createHash('sha256').update(JSON.stringify({ remoteRoot, ignores: unique })).digest('hex').slice(0, 40) };
}
