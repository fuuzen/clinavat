#!/usr/bin/env node
// Moves the Hub's data, environment file and release backups out of the source tree. Run as the Hub's system user
// with the Hub stopped; see docs/vm-isolation.md.
//
//   node deploy/relocate-data.mjs apply [--data <directory>]
//   node deploy/relocate-data.mjs rollback
//
// The targets default to ~/.local/share/clinavat, ~/.config/clinavat/hub.env and ~/.local/state/clinavat/releases.
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { databasePath, defaultDataDirectory, environmentFilePath, releaseRoot } from './environment.mjs';

const recordName = 'relocation.json';
// Development scaffolding without secrets; it stays with the source it tests.
const keptInSource = new Set(['experiments']);

const inside = (outer, path) => path === outer || path.startsWith(`${outer}${sep}`);
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function assertEmptyTarget(path) {
  if (!await exists(path)) return;
  if ((await readdir(path)).length) throw new Error(`目标目录不是空的：${path}`);
  await rm(path, { recursive: true });
}

function rewriteDatabase(dataDirectory, from, to) {
  const database = new DatabaseSync(databasePath(dataDirectory));
  try {
    database.exec('BEGIN IMMEDIATE');
    // Paths quoted in old messages and events are history; only live references change.
    for (const [table, column] of [['account_slots', 'home_dir'], ['sessions', 'jsonl_file_path']]) {
      database.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?`)
        .run(to, from.length + 1, from.length, from);
    }
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
}

// Files the Hub checks or regenerates; slot profile markers must name the slot's current home.
async function rewriteFile(file, from, to) {
  const content = await readFile(file, 'utf8');
  if (!content.includes(from)) return;
  const { mode } = await stat(file);
  const temporary = `${file}.relocating`;
  await writeFile(temporary, content.replaceAll(from, to), { mode: 0o600 });
  await chmod(temporary, mode & 0o777);
  await rename(temporary, file);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return entries.filter(entry => entry.isFile()).map(entry => join(directory, entry.name));
}

async function rewriteConfiguration(dataDirectory, from, to) {
  const files = [...await listFiles(join(dataDirectory, 'accounts', 'slot-profiles-v3')), join(dataDirectory, 'accounts', 'single-engine-slots.json')];
  const users = await readdir(join(dataDirectory, 'users')).catch(() => []);
  for (const user of users) {
    const home = join(dataDirectory, 'users', user);
    files.push(join(home, '.ssh', 'config'), ...await listFiles(join(home, '.ssh', 'config.d')), ...await listFiles(join(home, 'mutagen-ssh')));
  }
  for (const file of files) if (await exists(file)) await rewriteFile(file, from, to);
}

async function rewriteLinks(directory, from, to) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewriteLinks(path, from, to);
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (!inside(from, target)) continue;
      await rm(path);
      await symlink(to + target.slice(from.length), path);
    }
  }
}

async function moveEnvironment(source, target, dataDirectory, localOverrides) {
  const lines = (await readFile(source, 'utf8')).split('\n').filter(line => !line.startsWith('CLINAVAT_DATA_DIR='));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.relocating`;
  await writeFile(temporary, [`CLINAVAT_DATA_DIR=${dataDirectory}`, ...lines].join('\n'), { mode: 0o600 });
  await rename(temporary, target);
  await rm(source);
  // Vite reads its development settings from the source tree; none of them are secret.
  const vite = lines.filter(line => line.startsWith('VITE_'));
  if (localOverrides && vite.length) await writeFile(localOverrides, `${vite.join('\n')}\n`, { mode: 0o600 });
}

async function moveReleases(fromRoot, toRoot, names) {
  await mkdir(toRoot, { recursive: true, mode: 0o700 });
  for (const name of names) await rename(join(fromRoot, name), join(toRoot, name));
}

// Metadata only: login files are never read. A login lives in the slot's own directory and moves with it.
function loginFiles(dataDirectory, slots) {
  return Promise.all(slots.map(async slot => {
    const file = join(dataDirectory, 'slots', slot.id, slot.engine === 'codex' ? '.codex/auth.json' : '.claude/.credentials.json');
    const metadata = await stat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    return { id: slot.id, loggedIn: !!metadata, size: metadata?.size, modified: metadata?.mtimeMs };
  }));
}

function listSlots(dataDirectory) {
  const database = new DatabaseSync(databasePath(dataDirectory), { readOnly: true });
  try { return database.prepare('SELECT id,engine FROM account_slots ORDER BY id').all(); }
  finally { database.close(); }
}

/** Moves everything in `paths`; each completed step is undone if a later one fails. */
export async function relocate({ project, fromData, toData, fromEnvironment, toEnvironment, fromReleases, toReleases }) {
  if (inside(project, toData) || inside(project, toEnvironment) || inside(project, toReleases)) throw new Error('目标位置不能在项目目录内');
  await assertEmptyTarget(toData);
  if (await exists(toEnvironment)) throw new Error(`环境文件已存在：${toEnvironment}`);
  const journals = (await readdir(join(fromData, 'accounts', 'slot-runtime')).catch(() => [])).filter(name => name.endsWith('.json'));
  if (journals.length) throw new Error(`槽位 ${journals.map(name => name.slice(0, -5)).join('、')} 仍有未结束的租约，请先正常停止 Hub`);
  const releaseNames = (await readdir(fromReleases).catch(() => [])).filter(name => !keptInSource.has(name));
  const slots = listSlots(fromData);
  const logins = await loginFiles(fromData, slots);
  await mkdir(dirname(toData), { recursive: true, mode: 0o700 });
  const undo = [];
  try {
    await rename(fromData, toData);
    undo.push(() => rename(toData, fromData));
    rewriteDatabase(toData, fromData, toData);
    undo.push(async () => rewriteDatabase(toData, toData, fromData));
    await rewriteConfiguration(toData, fromData, toData);
    undo.push(() => rewriteConfiguration(toData, toData, fromData));
    await rewriteLinks(toData, fromData, toData);
    undo.push(() => rewriteLinks(toData, toData, fromData));
    if (JSON.stringify(await loginFiles(toData, slots)) !== JSON.stringify(logins)) throw new Error('槽位登录文件与移动前不一致');
    await moveReleases(fromReleases, toReleases, releaseNames);
    undo.push(() => moveReleases(toReleases, fromReleases, releaseNames));
    await writeFile(join(toData, recordName), JSON.stringify({ project, fromData, toData, fromEnvironment, toEnvironment, fromReleases, toReleases, releaseNames }, null, 2), { mode: 0o600 });
    undo.push(() => rm(join(toData, recordName)));
    await moveEnvironment(fromEnvironment, toEnvironment, toData, join(project, '.env.local'));
  } catch (error) {
    for (const step of undo.reverse()) await step().catch(failure => console.error(`恢复步骤失败：${failure.message}`));
    throw error;
  }
  return logins.map(({ id, loggedIn }) => ({ id, loggedIn }));
}

export async function restore(dataDirectory) {
  const record = JSON.parse(await readFile(join(dataDirectory, recordName), 'utf8'));
  const { project, fromData, toData, fromEnvironment, toEnvironment, fromReleases, toReleases, releaseNames } = record;
  if (await exists(fromData)) throw new Error(`原位置已存在数据：${fromData}`);
  await moveEnvironment(toEnvironment, fromEnvironment, fromData);
  await rm(join(project, '.env.local'), { force: true });
  await moveReleases(toReleases, fromReleases, releaseNames);
  await rewriteLinks(toData, toData, fromData);
  await rewriteConfiguration(toData, toData, fromData);
  rewriteDatabase(toData, toData, fromData);
  await rm(join(toData, recordName));
  await rename(toData, fromData);
}

function assertServicesStopped() {
  for (const unit of ['clinavat-hub.service', 'clinavat-web.service']) {
    if (spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit]).status === 0) throw new Error(`${unit} 正在运行，请先执行 npm run host:stop`);
  }
}

// A running guest keeps its mounts on the moved directories and would go on writing through them.
function assertNoInstanceUses(dataDirectory) {
  const remote = process.env.CLINAVAT_LXD_REMOTE || 'clinavat-host';
  const project = process.env.CLINAVAT_LXD_PROJECT || 'clinavat';
  const listed = spawnSync(process.env.CLINAVAT_LXC_BIN || 'lxc', ['list', `${remote}:`, '--project', project, '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (listed.status !== 0) throw new Error(`无法读取 LXD 实例：${listed.stderr.trim()}`);
  const holders = JSON.parse(listed.stdout).filter(row => Object.values(row.devices ?? {}).some(device => device.source && inside(dataDirectory, device.source)));
  if (holders.length) throw new Error(`实例 ${holders.map(row => row.name).join('、')} 仍挂载着数据目录，请先执行 sudo deploy/lxd/egress-bindings.sh remove-old-machines --hub-user <Hub 用户>`);
}

async function main() {
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const command = process.argv[2];
  assertServicesStopped();
  if (command === 'apply') {
    const dataFlag = process.argv.indexOf('--data');
    const fromEnvironment = join(project, '.env');
    process.loadEnvFile(fromEnvironment);
    const fromData = await realpath(resolve(project, 'backend', process.env.CLINAVAT_DATA_DIR || '../data'));
    if (process.env.CLINAVAT_EXECUTION_HOST === 'lxd') assertNoInstanceUses(fromData);
    const toData = resolve(dataFlag > 0 ? process.argv[dataFlag + 1] : defaultDataDirectory());
    const logins = await relocate({ project, fromData, toData, fromEnvironment, toEnvironment: environmentFilePath(), fromReleases: join(project, '.releases'), toReleases: releaseRoot() });
    for (const { id, loggedIn } of logins) console.log(`槽位 ${id}：${loggedIn ? '登录状态已随数据移动，无需重新登录' : '尚未登录'}`);
    console.log(`数据目录：${toData}\n环境文件：${environmentFilePath()}\n发布备份：${releaseRoot()}`);
    console.log('接下来按 docs/vm-isolation.md 更新 LXD 挂载白名单，再执行 npm run host:install。');
  } else if (command === 'rollback') {
    process.loadEnvFile(environmentFilePath());
    await restore(resolve(process.env.CLINAVAT_DATA_DIR || defaultDataDirectory()));
    console.log('已恢复到项目目录内。请恢复 LXD 挂载白名单，再执行 npm run host:install。');
  } else {
    console.error('用法：node deploy/relocate-data.mjs apply [--data <目录>] | rollback');
    process.exitCode = 64;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(`失败：${error.message}`); process.exitCode = 1; });
}
