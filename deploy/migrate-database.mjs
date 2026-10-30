import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, readlink, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from './environment.mjs';
import { activityCounts, currentServices, gateCount, hasActivity, legacyServices, serviceState } from './release-state.mjs';

const script = fileURLToPath(import.meta.url);
const projectDirectory = dirname(dirname(script));
loadEnvironment(join(projectDirectory, '.env'));
const dataDirectory = resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR ?? '../data');
const source = join(dataDirectory, 'cc-pool.sqlite');
const destination = join(dataDirectory, 'clinavat.sqlite');
const sessionManagerNames = new Set(['systemd', '(sd-pam)', 'ssh-agent', 'sshd', 'sshd-session']);

async function metadata(path) {
  return lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function requireStoppedServices() {
  for (const service of [...currentServices, ...legacyServices]) {
    const state = await serviceState(service);
    if (!['inactive', 'failed'].includes(state.ActiveState) || (state.MainPID && state.MainPID !== '0')) {
      throw new Error(`请先停止服务 ${service}，迁移命令不会中断运行中的任务`);
    }
  }
}

async function exitedProcess(directory) {
  try {
    const contents = await readFile(join(directory, 'stat'), 'utf8');
    return ['Z', 'X'].includes(contents.slice(contents.lastIndexOf(')') + 1).trimStart().split(/\s+/, 1)[0]);
  } catch (error) { return ['ENOENT', 'ESRCH'].includes(error.code); }
}

async function knownSessionManager(directory) {
  try { return sessionManagerNames.has((await readFile(join(directory, 'comm'), 'utf8')).trim()); }
  catch (error) { return ['ENOENT', 'ESRCH'].includes(error.code); }
}

async function requireNoProcesses(homes = new Set(), sessions = new Set()) {
  const sourcePath = await realpath(source);
  const probeDirectory = `${resolve(dataDirectory, 'run', 'usage-probes')}${sep}`;
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name) || Number(entry.name) === process.pid) continue;
    const directory = join('/proc', entry.name);
    try {
      if ((await stat(directory)).uid !== process.getuid()) continue;
      if (await exitedProcess(directory)) continue;
      const environment = (await readFile(join(directory, 'environ'), 'utf8')).split('\0');
      const runtimeHome = environment.find(value => value.startsWith('HOME='))?.slice(5);
      const sessionId = environment.find(value => value.startsWith('CLINAVAT_SESSION_ID=') || value.startsWith('CC_POOL_SESSION_ID='))?.split('=')[1];
      if ((sessionId && sessions.has(sessionId)) || (runtimeHome && (homes.has(resolve(runtimeHome)) || resolve(runtimeHome).startsWith(probeDirectory)))) {
        throw new Error(`账号相关进程 ${entry.name} 尚未退出，拒绝迁移数据库`);
      }
      for (const descriptor of await readdir(join(directory, 'fd'))) {
        const target = await readlink(join(directory, 'fd', descriptor)).catch(error => {
          if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
          return '';
        });
        if ([sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`].includes(target)) {
          throw new Error(`进程 ${entry.name} 仍打开旧数据库，拒绝迁移`);
        }
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
      if (['EACCES', 'EPERM'].includes(error.code)) {
        // Session managers may be non-dumpable; their CLI children are still inspected individually.
        if (await exitedProcess(directory) || await knownSessionManager(directory)) continue;
        throw new Error(`无法确认同用户进程 ${entry.name} 是否仍在使用数据库`);
      }
      throw error;
    }
  }
}

async function migrate() {
  await requireStoppedServices();
  const previous = await metadata(source);
  const current = await metadata(destination);
  if (current) {
    if (previous) throw new Error('新旧数据库同时存在，保留两者，请先确认已有迁移状态');
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('Clinavat 数据库必须是实际文件');
    console.log('数据库已经使用 clinavat.sqlite，无需再次迁移');
    return;
  }
  if (!previous?.isFile() || previous.isSymbolicLink()) throw new Error('找不到可迁移的 cc-pool.sqlite 实际文件');
  if (await metadata(`${destination}-wal`) || await metadata(`${destination}-shm`)) {
    throw new Error('新数据库名已有 SQLite 辅助文件，拒绝将旧数据库与这些文件混用');
  }
  await requireNoProcesses();
  const database = new DatabaseSync(source);
  const homes = new Set();
  const sessions = new Set();
  try {
    database.exec('PRAGMA busy_timeout=5000');
    if (gateCount(database)) throw new Error('存在发布门禁，请先完成发布恢复并解除门禁');
    if (hasActivity(activityCounts(database))) throw new Error('数据库仍有活跃或暂停任务，请先在原系统中结束任务');
    for (const row of database.prepare('SELECT home_dir FROM account_slots').all()) homes.add(resolve(row.home_dir));
    for (const row of database.prepare('SELECT id FROM sessions').all()) sessions.add(row.id);
    await requireNoProcesses(homes, sessions);
    const journals = await readdir(join(dataDirectory, 'accounts', 'slot-runtime')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    if (journals.length) throw new Error('仍有账号运行恢复记录，请先启动原系统完成回收');
    const check = database.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('数据库完整性检查未通过，保留原文件');
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy !== 0) throw new Error('仍有 SQLite 连接占用 WAL，保留原文件');
  } finally { database.close(); }
  await requireStoppedServices();
  await requireNoProcesses(homes, sessions);
  if (await metadata(`${source}-wal`) || await metadata(`${source}-shm`)) {
    throw new Error('SQLite 辅助文件仍存在，请确认所有连接均已关闭后重试');
  }
  const backupDirectory = join(dataDirectory, 'backups');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backup = join(backupDirectory, `cc-pool-before-clinavat-${Date.now()}-${process.pid}.sqlite`);
  await copyFile(source, backup, constants.COPYFILE_EXCL);
  await chmod(backup, 0o600);
  if (await metadata(`${destination}-wal`) || await metadata(`${destination}-shm`)) {
    throw new Error('备份后检测到新数据库名的 SQLite 辅助文件，保留原数据库');
  }
  // A hard link atomically reserves the destination without replacing an existing file.
  await link(source, destination);
  await unlink(source);
  console.log(JSON.stringify({ state: 'migrated', database: destination, backup }));
}

try {
  if (process.argv.slice(2).some(argument => argument !== '--locked')) throw new Error('用法：node deploy/migrate-database.mjs');
  if (process.argv.includes('--locked')) await migrate();
  else {
    const result = spawnSync('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', join(dataDirectory, 'release.lock'),
      process.execPath, '--no-warnings', script, '--locked'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
