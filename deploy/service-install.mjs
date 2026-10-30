import { existsSync } from 'node:fs';
import { readdir, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { databasePath } from './environment.mjs';
import { activityCounts, controlService, currentServices, gateCount, hasActivity, hasRuntimeActivity,
  installGate, legacyServices, openDatabase, removeGate, runtimeCounts, serviceState } from './release-state.mjs';

function reachableHost(value) {
  return value === '0.0.0.0' ? '127.0.0.1' : value === '::' ? '[::1]' : value.includes(':') ? `[${value}]` : value;
}

async function waitForHealth(web = false) {
  const host = reachableHost(process.env[web ? 'CLINAVAT_WEB_BIND' : 'CLINAVAT_HOST'] ?? '127.0.0.1');
  const port = process.env[web ? 'CLINAVAT_WEB_PORT' : 'CLINAVAT_PORT'] ?? (web ? '8080' : '3001');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/${web ? '' : 'api/health'}`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (web || (await response.json()).status === 'ok')) return;
    } catch { /* The service may be active before its listener is ready. */ }
    await delay(500);
  }
  throw new Error(`${web ? 'Web' : 'Hub'} 服务健康检查失败`);
}

async function waitForIdle(database, dataDirectory, hub) {
  const deadline = Date.now() + 45_000;
  let cleanSamples = 0;
  while (Date.now() < deadline) {
    if (hasActivity(activityCounts(database))) throw new Error('仍有活跃对话，暂不切换服务');
    cleanSamples = hasRuntimeActivity(await runtimeCounts(database, dataDirectory, hub)) ? 0 : cleanSamples + 1;
    if (cleanSamples >= 2) return;
    await delay(500);
  }
  throw new Error('账号准备或额度查询尚未退出，暂不切换服务');
}

export async function ensureInstallIdle(dataDirectory) {
  const hubs = await Promise.all([serviceState(currentServices[0]), serviceState(legacyServices[0])]);
  const running = hubs.filter(hub => hub.MainPID && hub.MainPID !== '0');
  if (running.length > 1) throw new Error('新旧 Hub 同时运行，拒绝自动迁移');
  const existingDatabase = ['clinavat.sqlite', 'cc-pool.sqlite'].some(name => existsSync(join(dataDirectory, name)));
  if (!existingDatabase) {
    if (running.length) throw new Error('Hub 正在运行，但配置目录没有数据库；拒绝初始化空数据');
    return;
  }
  if (running.length) {
    const expected = await realpath(databasePath(dataDirectory));
    const directory = `/proc/${running[0].MainPID}/fd`;
    const targets = await Promise.all((await readdir(directory)).map(descriptor => readlink(join(directory, descriptor)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    })));
    if (!targets.includes(expected)) throw new Error('配置数据库与在线 Hub 实际使用的数据库不一致，拒绝切换');
  }
  const database = openDatabase(dataDirectory);
  try {
    if (gateCount(database)) throw new Error('存在发布门禁，请先确认部署完整并解除门禁');
    if (hasActivity(activityCounts(database))) throw new Error('仍有活跃或暂停的对话，请结束后重新安装服务');
  } finally { database.close(); }
}

export async function activateServices(dataDirectory, restoreUnits) {
  const [current, legacy] = await Promise.all([
    Promise.all(currentServices.map(serviceState)), Promise.all(legacyServices.map(serviceState)),
  ]);
  const active = state => ['active', 'activating', 'reloading', 'deactivating'].includes(state.ActiveState);
  if (current.some(active) && legacy.some(active)) throw new Error('新旧服务同时运行，拒绝自动迁移');
  const previousServices = legacy.some(active) ? legacyServices : currentServices;
  const previousStates = previousServices === legacyServices ? legacy : current;
  const database = ['clinavat.sqlite', 'cc-pool.sqlite'].some(name => existsSync(join(dataDirectory, name)))
    ? openDatabase(dataDirectory, false) : undefined;
  let gated = false;
  let switched = false;
  let completed = false;
  let safeToUnblock = true;
  try {
    if (database) {
      if (gateCount(database)) throw new Error('存在发布门禁，请先确认部署完整并解除门禁');
      if (installGate(database)) throw new Error('仍有活跃对话，请结束后重新安装服务');
      gated = true;
    }
    switched = true;
    await controlService('stop', previousServices[1]);
    if (database) await waitForIdle(database, dataDirectory, previousStates[0]);
    await controlService('stop', previousServices[0]);
    for (const [index, service] of legacyServices.entries()) {
      if (legacy[index].LoadState === 'loaded') {
        await controlService('stop', service);
        if (legacy[index].UnitFileState === 'enabled') await controlService('disable', service);
      }
    }
    for (const service of currentServices) await controlService('enable', service);
    await controlService('start', currentServices[0]);
    await waitForHealth();
    await controlService('start', currentServices[1]);
    await waitForHealth(true);
    completed = true;
  } catch (error) {
    if (switched) {
      try {
        for (const service of currentServices.toReversed()) await controlService('stop', service);
        for (const [index, service] of currentServices.entries()) {
          if (current[index].UnitFileState !== 'enabled') await controlService('disable', service);
        }
        await restoreUnits();
        for (const [index, service] of legacyServices.entries()) {
          if (legacy[index].UnitFileState === 'enabled') await controlService('enable', service);
        }
        for (const [index, service] of previousServices.entries()) {
          if (active(previousStates[index])) await controlService('start', service);
        }
        if (active(previousStates[0])) await waitForHealth();
        if (active(previousStates[1])) await waitForHealth(true);
      } catch (recoveryError) {
        safeToUnblock = false;
        throw new Error(`服务切换失败且自动恢复未完成，保留发布门禁：${error.message}；恢复错误：${recoveryError.message}`);
      }
    }
    throw error;
  } finally {
    try { if (database && gated && (completed || safeToUnblock)) removeGate(database); }
    finally { database?.close(); }
  }
}
