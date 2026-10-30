import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { databasePath } from './environment.mjs';

const execute = promisify(execFile);
export const currentServices = ['clinavat-hub.service', 'clinavat-web.service'];
export const legacyServices = ['cc-pool-hub.service', 'cc-pool-web.service'];
export const services = [...currentServices];
const gateSuffixes = ['sessions_insert', 'sessions_update', 'turns_insert', 'turns_update'];
const gateNames = gateSuffixes.map(name => `clinavat_release_${name}`);
const allGateNames = [...gateNames, ...gateSuffixes.map(name => `cc_pool_release_${name}`)];

export async function discoverServices() {
  const [current, legacy] = await Promise.all([
    Promise.all(currentServices.map(serviceState)), Promise.all(legacyServices.map(serviceState)),
  ]);
  const running = states => states.some(state => ['active', 'activating', 'deactivating', 'reloading'].includes(state.ActiveState));
  if (running(current) && running(legacy)) throw new Error('新旧服务同时运行，请先恢复到单一部署');
  const selected = running(legacy) || (!current.some(state => state.LoadState === 'loaded') && legacy.some(state => state.LoadState === 'loaded'))
    ? legacyServices : currentServices;
  services.splice(0, services.length, ...selected);
  return services;
}

export async function serviceState(service) {
  const { stdout } = await execute('systemctl', ['--user', 'show', service, '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,UnitFileState'], { timeout: 10000 });
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export async function controlService(action, service) {
  try { await execute('systemctl', ['--user', action, service], { timeout: 45000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error(`${service} ${action} 未完成，请检查 systemd 服务状态`); }
}

export function openDatabase(dataDirectory, readOnly = true) {
  const database = new DatabaseSync(databasePath(dataDirectory), { readOnly });
  database.exec('PRAGMA busy_timeout=5000');
  return database;
}

export function activityCounts(database) {
  return {
    sessions: database.prepare("SELECT count(*) AS count FROM sessions WHERE lower(status) IN ('running','waiting','pausing','paused','streaming','waiting_approval')").get().count,
    turns: database.prepare("SELECT count(*) AS count FROM session_turns WHERE lower(status) IN ('running','pausing','paused')").get().count,
    approvals: database.prepare("SELECT count(*) AS count FROM approvals WHERE lower(status)='pending'").get().count,
  };
}

export function hasActivity(counts) { return counts.sessions > 0 || counts.turns > 0 || counts.approvals > 0; }

export function gateCount(database) {
  return allGateNames.filter(name => database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)).length;
}

export function installGate(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const counts = activityCounts(database);
    if (hasActivity(counts)) { database.exec('ROLLBACK'); return counts; }
    if (gateCount(database)) throw new Error('存在未清理的发布门禁，请先确认服务目录完整，再执行 unblock');
    // Live versions persist running before starting a CLI. The transaction closes the idle-check/start race.
    for (const [name, table, operation] of [
      [gateNames[0], 'sessions', 'INSERT'], [gateNames[1], 'sessions', 'UPDATE OF status'],
      [gateNames[2], 'session_turns', 'INSERT'], [gateNames[3], 'session_turns', 'UPDATE OF status'],
    ]) {
      database.exec(`CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
        WHEN lower(NEW.status) IN ('running','waiting','pausing','paused','streaming','waiting_approval')
        BEGIN SELECT RAISE(ABORT, 'CLINAVAT_RELEASE_IN_PROGRESS'); END`);
    }
    database.exec('COMMIT');
    return null;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function removeGate(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const name of allGateNames) database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

async function directoryEntries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function groupProcesses(directory) {
  const pids = (await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim().split('\n').filter(Boolean);
  for (const entry of await directoryEntries(directory)) {
    if (entry.isDirectory()) pids.push(...await groupProcesses(join(directory, entry.name)));
  }
  return pids;
}

export async function runtimeCounts(database, dataDirectory, hub) {
  const journals = await directoryEntries(join(dataDirectory, 'accounts', 'slot-runtime'));
  const probeDirectory = resolve(dataDirectory, 'run', 'usage-probes');
  // Each child survives CLI exit until refreshed credentials have been copied back.
  const probeHomes = (await directoryEntries(probeDirectory)).filter(entry => entry.isDirectory());
  const homes = new Set(database.prepare('SELECT home_dir FROM account_slots').all().map(slot => resolve(slot.home_dir)));
  let conversationProcesses = 0;
  let usageProbeProcesses = 0;
  if (hub.ActiveState === 'active' && hub.ControlGroup) {
    if (!hub.ControlGroup.startsWith('/') || hub.ControlGroup.includes('..')) throw new Error('无法确认 Hub 进程组');
    // Only inspect this deployment's cgroup; development and preview servers are deliberately excluded.
    for (const pid of await groupProcesses(`/sys/fs/cgroup${hub.ControlGroup}`)) {
      if (pid === hub.MainPID) continue;
      try {
        const values = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
        const runtimeHome = values.find(value => value.startsWith('HOME='))?.slice(5);
        if (values.some(value => value.startsWith('CLINAVAT_SESSION_ID=') || value.startsWith('CC_POOL_SESSION_ID=')) || (runtimeHome && homes.has(resolve(runtimeHome)))) conversationProcesses++;
        if (runtimeHome && resolve(runtimeHome).startsWith(`${probeDirectory}${sep}`)) usageProbeProcesses++;
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw new Error(`无法确认 Hub 子进程 ${pid} 的归属`); }
    }
  }
  return { runtimeJournals: journals.length, conversationProcesses, usageProbeDirectories: probeHomes.length, usageProbeProcesses };
}

export function hasRuntimeActivity(runtime, includeUsageProbes = true) {
  return runtime.runtimeJournals > 0 || runtime.conversationProcesses > 0
    || (includeUsageProbes && (runtime.usageProbeDirectories > 0 || runtime.usageProbeProcesses > 0));
}

export async function deploymentStatus(dataDirectory) {
  await discoverServices();
  const database = openDatabase(dataDirectory);
  try {
    const [hub, web] = await Promise.all(services.map(serviceState));
    const activity = activityCounts(database);
    const runtime = await runtimeCounts(database, dataDirectory, hub);
    return { checkedAt: new Date().toISOString(), state: hasActivity(activity) || hasRuntimeActivity(runtime) ? 'waiting' : 'idle',
      ...activity, ...runtime, gateTriggers: gateCount(database), services: { hub: hub.ActiveState, web: web.ActiveState } };
  } finally { database.close(); }
}
