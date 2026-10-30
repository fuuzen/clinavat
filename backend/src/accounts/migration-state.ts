import { DatabaseSync } from 'node:sqlite';
import { cp, lstat, readdir, readFile, readlink, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Store } from '../database.js';
import { clearRuntimeCredential, privateDirectory, readPrivateJson, writePrivateJson } from './credential-files.js';
import { userRuntimeHome } from './paths.js';

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

const sessionManagerNames = new Set(['systemd', '(sd-pam)', 'ssh-agent', 'sshd', 'sshd-session']);

async function exitedProcess(pid: string): Promise<boolean> {
  try {
    const contents = await readFile(join('/proc', pid, 'stat'), 'utf8');
    const commandEnd = contents.lastIndexOf(')');
    const state = commandEnd < 0 ? '' : contents.slice(commandEnd + 1).trimStart().split(/\s+/, 1)[0];
    return state === 'Z' || state === 'X';
  } catch (error) {
    return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '');
  }
}

async function knownSessionManager(pid: string): Promise<boolean> {
  try { return sessionManagerNames.has((await readFile(join('/proc', pid, 'comm'), 'utf8')).trim()); }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) return true;
    return false;
  }
}

export async function assertAccountProcessesStopped(dataDir: string, slotHomes: string[]): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('账号运行目录迁移与恢复需要 Linux /proc 进程检查');
  const homes = new Set(slotHomes.map(home => resolve(home)));
  const usersRoot = resolve(dataDir, 'users');
  const ownedHome = (home: string) => {
    if (!home.startsWith('/')) return false;
    const normalized = resolve(home);
    if (homes.has(normalized)) return true;
    const parts = relative(usersRoot, normalized).split(sep);
    const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    return (parts.length === 2 && identifier.test(parts[0]) && parts[1] === 'runtime')
      || (parts.length === 4 && identifier.test(parts[0]) && ['sessions', 'model-probes'].includes(parts[1])
        && identifier.test(parts[2]) && parts[3] === 'runtime');
  };
  const survivors: string[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      if ((await stat(join('/proc', pid))).uid !== process.getuid()) continue;
      const environment = await readFile(join('/proc', pid, 'environ'));
      const matches = environment.toString().split('\0').some(entry => {
        if (entry.startsWith('HOME=')) return ownedHome(entry.slice(5));
        if (entry.startsWith('CODEX_HOME=')) return ownedHome(dirname(entry.slice(11)));
        if (entry.startsWith('CLAUDE_CONFIG_DIR=')) return ownedHome(dirname(entry.slice(18)));
        return false;
      });
      if (matches) survivors.push(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || '';
      if (['ENOENT', 'ESRCH'].includes(code)) continue;
      if (['EACCES', 'EPERM'].includes(code)) {
        // Zombies can have unreadable environ files, but have already released their open files.
        if (await exitedProcess(pid)) continue;
        // PAM/SSH session managers are often non-dumpable. Their CLI children are checked separately.
        if (await knownSessionManager(pid)) continue;
      }
      throw new Error(`无法检查同一运行用户的进程 ${pid}，已停止账号迁移与凭据恢复`);
    }
  }
  if (survivors.length) throw new Error(`账号运行环境仍被进程 ${survivors.join(', ')} 使用，请停止残留 CLI 及子进程后重启 Hub`);
}

const quoteSql = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function relocateCodexPaths(home: string, oldHome: string, finalHome: string): Promise<void> {
  const directory = join(home, '.codex');
  const files = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files) {
    if (!file.isFile() || !/\.(?:sqlite|db)$/.test(file.name)) continue;
    const db = new DatabaseSync(join(directory, file.name));
    try {
      db.exec('BEGIN IMMEDIATE');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE '%VIRTUAL TABLE%'").all() as { name: string }[];
      for (const { name } of tables) {
        const columns = db.prepare(`PRAGMA table_info(${quoteSql(name)})`).all() as { name: string; type: string }[];
        for (const column of columns) {
          if (!/^(?:path|cwd|home_dir|.*_path)$/.test(column.name) || !/TEXT/i.test(column.type)) continue;
          const field = quoteSql(column.name);
          db.prepare(`UPDATE ${quoteSql(name)} SET ${field}=? || substr(${field},?) WHERE ${field}=? OR substr(${field},1,?)=?`)
            .run(finalHome, oldHome.length + 1, oldHome, oldHome.length + 1, `${oldHome}/`);
        }
      }
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* The transaction may already have committed. */ }
      throw error;
    } finally { db.close(); }
  }
}

export async function relocateHomeLinks(directory: string, staging: string, oldHome: string, finalHome: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await relocateHomeLinks(file, staging, oldHome, finalHome);
    else if (entry.isSymbolicLink()) {
      const target = await readlink(file);
      const originalLocation = join(oldHome, relative(staging, file));
      const absoluteTarget = resolve(dirname(originalLocation), target);
      const withinHome = relative(oldHome, absoluteTarget);
      if (withinHome === '..' || withinHome.startsWith(`..${sep}`) || withinHome.startsWith(sep)) continue;
      await rm(file);
      await symlink(resolve(finalHome, withinHome), file);
    }
  }
}

export async function migrateUserState(dataDir: string, userId: string, slotId: string, archive: string, oldHome: string): Promise<void> {
  const home = userRuntimeHome(dataDir, userId);
  const markerName = '.account-home-migration.json';
  const marker = await readPrivateJson(join(home, markerName));
  if (marker) {
    const previous = JSON.parse(marker) as { slotId?: string; userId?: string };
    if (previous.slotId === slotId && previous.userId === userId) return;
    throw new Error('用户运行目录已有其他迁移记录，已保留原数据');
  }
  if (await pathExists(home)) throw new Error('用户运行目录已存在，拒绝覆盖已有会话');
  await privateDirectory(dirname(home));
  const staging = join(dirname(home), `.runtime-migration-${slotId}`);
  // Only this migration's unpublished staging directory is replaceable; the archive stays intact.
  await rm(staging, { recursive: true, force: true });
  await cp(archive, staging, {
    recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
    filter: async source => {
      const metadata = await lstat(source);
      return metadata.isDirectory() || metadata.isFile() || metadata.isSymbolicLink();
    },
  });
  await privateDirectory(staging);
  await relocateHomeLinks(staging, staging, oldHome, home);
  await clearRuntimeCredential(staging, 'claude');
  await clearRuntimeCredential(staging, 'codex');
  await relocateCodexPaths(staging, oldHome, home);
  await writePrivateJson(join(staging, markerName), JSON.stringify({ slotId, userId }));
  await rename(staging, home);
}

export function migrateSessionPaths(store: Store, userId: string, oldHome: string, newHome: string): void {
  store.run(`UPDATE sessions SET jsonl_file_path=? || substr(jsonl_file_path,?),updated_at=datetime('now')
    WHERE user_id=? AND (jsonl_file_path=? OR substr(jsonl_file_path,1,?)=?)`,
  newHome, oldHome.length + 1, userId, oldHome, oldHome.length + 1, `${oldHome}/`);
}
