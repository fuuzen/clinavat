import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { databasePath, loadEnvironment } from './environment.mjs';
import { activityCounts, controlService, deploymentStatus, gateCount, hasActivity, hasRuntimeActivity, installGate,
  openDatabase, removeGate, runtimeCounts, services, serviceState } from './release-state.mjs';

const script = fileURLToPath(import.meta.url);
const projectDirectory = dirname(dirname(script));
loadEnvironment(join(projectDirectory, '.env'));
const dataDirectory = resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR ?? '../data');
const command = process.argv[2] ?? 'status';
const argument = process.argv[3];
const locked = process.argv.includes('--locked');
const frontendOnly = process.argv.includes('--frontend-only');
const releaseParts = frontendOnly ? ['frontend'] : ['backend', 'frontend'];
let cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; });
function checkCancelled() { if (cancelled) throw new Error('发布已取消，将恢复原服务并移除门禁'); }

function inside(parent, child) {
  const within = relative(parent, child);
  return within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !within.startsWith(sep));
}

async function requireDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`需要实际目录：${directory}`);
}

async function buildFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await buildFiles(directory, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`构建目录不能包含符号链接或特殊文件：${path}`);
  }
  return files.sort();
}

async function requireMatchingBackend(staged) {
  const live = join(projectDirectory, 'backend', 'dist');
  const [stagedFiles, liveFiles] = await Promise.all([buildFiles(staged), buildFiles(live)]);
  if (stagedFiles.length !== liveFiles.length || stagedFiles.some((file, index) => file !== liveFiles[index])) {
    throw new Error('--frontend-only 要求后端暂存构建与在线构建的文件清单完全一致');
  }
  for (const file of liveFiles) {
    const [expected, actual] = await Promise.all([readFile(join(live, file)), readFile(join(staged, file))]);
    if (!expected.equals(actual)) throw new Error(`--frontend-only 不允许后端变更：${file}`);
  }
}

async function prepareRelease(staging) {
  const source = await realpath(resolve(staging));
  const releaseId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const releaseDirectory = join(projectDirectory, '.releases', releaseId);
  const nextDirectory = join(releaseDirectory, 'next');
  const previousDirectory = join(releaseDirectory, 'previous');
  for (const part of ['backend', 'frontend']) {
    const live = join(projectDirectory, part, 'dist');
    if (inside(live, source) || inside(source, live) || inside(dataDirectory, source)) throw new Error('暂存目录不能包含在线 dist 或部署数据目录');
    await requireDirectory(live);
    await requireDirectory(join(source, part));
  }
  await stat(join(source, 'backend', 'server.js'));
  await stat(join(source, 'frontend', 'index.html'));
  if (frontendOnly) await requireMatchingBackend(join(source, 'backend'));
  await mkdir(nextDirectory, { recursive: true, mode: 0o700 });
  await mkdir(previousDirectory, { mode: 0o700 });
  const device = (await stat(releaseDirectory)).dev;
  for (const part of releaseParts) {
    if ((await stat(join(projectDirectory, part))).dev !== device) throw new Error('发布备份与在线 dist 必须位于同一文件系统');
    await cp(join(source, part), join(nextDirectory, part), { recursive: true, errorOnExist: true, force: false,
      filter: async file => {
        const metadata = await lstat(file);
        if (!metadata.isFile() && !metadata.isDirectory()) throw new Error('构建目录不能包含符号链接或特殊文件');
        return true;
      } });
  }
  return { releaseId, releaseDirectory, nextDirectory, previousDirectory };
}

async function verifyService(hub) {
  if (hub.ActiveState !== 'active' || !hub.MainPID || hub.MainPID === '0') throw new Error('Hub 未运行；本命令只负责更新已运行的宿主部署');
  const argumentsList = (await readFile(`/proc/${hub.MainPID}/cmdline`, 'utf8')).split('\0');
  if (!argumentsList.includes(join(projectDirectory, 'backend', 'dist', 'server.js'))) throw new Error('Hub 服务运行路径与本仓库不一致');
  const openedDatabasePath = await realpath(databasePath(dataDirectory));
  const descriptors = await readdir(`/proc/${hub.MainPID}/fd`);
  const targets = await Promise.all(descriptors.map(descriptor => readlink(`/proc/${hub.MainPID}/fd/${descriptor}`).catch(() => '')));
  if (!targets.includes(openedDatabasePath)) throw new Error('当前配置数据库与在线 Hub 实际打开的数据库不一致');
}

function reachableHost(value) {
  return value === '0.0.0.0' ? '127.0.0.1' : value === '::' ? '[::1]' : value.includes(':') ? `[${value}]` : value;
}

async function webCheck() {
  const host = reachableHost(process.env.CLINAVAT_WEB_BIND ?? '127.0.0.1');
  const expected = await readFile(join(projectDirectory, 'frontend', 'dist', 'index.html'), 'utf8');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${process.env.CLINAVAT_WEB_PORT ?? '8080'}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && await response.text() === expected) return;
    } catch { /* A simple systemd service can be active before its listener is ready. */ }
    await delay(500);
  }
  throw new Error('前端健康检查失败：未返回当前构建的页面');
}

async function healthCheck() {
  const configuredHost = process.env.CLINAVAT_HOST ?? '127.0.0.1';
  const host = reachableHost(configuredHost);
  const address = `http://${host}:${process.env.CLINAVAT_PORT ?? '3001'}/api/health`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(address, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* Wait for the service to become ready. */ }
    await delay(500);
  }
  throw new Error('后端健康检查失败');
}

async function drainPreparations(database) {
  const deadline = Date.now() + 45000;
  let cleanSamples = 0;
  while (Date.now() < deadline) {
    checkCancelled();
    const activity = activityCounts(database);
    if (hasActivity(activity)) throw new Error('发布门禁后仍检测到活跃对话，已中止发布');
    const runtime = await runtimeCounts(database, dataDirectory, await serviceState(services[0]));
    cleanSamples = hasRuntimeActivity(runtime, !frontendOnly) ? 0 : cleanSamples + 1;
    if (cleanSamples >= 2) return;
    await delay(500);
  }
  throw new Error('账号准备、额度查询或凭据回收尚未结束，保留原部署，请稍后重试');
}

async function publish(staging) {
  const initial = await deploymentStatus(dataDirectory);
  // Frontend-only releases leave the Hub and its quota probes running throughout.
  if (hasActivity(initial) || hasRuntimeActivity(initial, !frontendOnly)) {
    console.log(JSON.stringify(initial)); process.exitCode = 75; return;
  }
  if (initial.gateTriggers) throw new Error('存在遗留发布门禁；检查服务完整后执行 unblock');
  if (initial.services.web !== 'active') throw new Error('Web 服务未运行，请先恢复当前部署');
  await verifyService(await serviceState(services[0]));
  const release = await prepareRelease(staging);
  checkCancelled();
  const database = openDatabase(dataDirectory, false);
  const moved = [];
  let gated = false;
  let webStopped = false;
  let hubStopped = false;
  let finished = false;
  let recoveryFailed = false;
  async function record(phase) {
    const stateFile = join(release.releaseDirectory, 'release.json');
    await writeFile(`${stateFile}.next`, JSON.stringify({ releaseId: release.releaseId, frontendOnly, phase, moved, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    await rename(`${stateFile}.next`, stateFile);
  }
  try {
    const waiting = installGate(database);
    if (waiting) { console.log(JSON.stringify({ state: 'waiting', ...waiting })); process.exitCode = 75; return; }
    gated = true;
    await record('gated');
    checkCancelled();
    // Close the normal ingress while in-flight preparation requests unwind against the database gate.
    webStopped = true;
    await controlService('stop', services[1]);
    await drainPreparations(database);
    checkCancelled();
    if (!frontendOnly) {
      hubStopped = true;
      await controlService('stop', services[0]);
    }
    checkCancelled();
    await record('stopped');
    for (const part of releaseParts) {
      const live = join(projectDirectory, part, 'dist');
      await rename(live, join(release.previousDirectory, part));
      moved.push(part);
      await record('switching');
      await rename(join(release.nextDirectory, part), live);
    }
    await record('starting');
    if (!frontendOnly) {
      await controlService('start', services[0]);
      hubStopped = false;
    }
    await healthCheck();
    checkCancelled();
    await controlService('start', services[1]);
    webStopped = false;
    await webCheck();
    checkCancelled();
    await record('complete');
    finished = true;
  } catch (error) {
    try {
      if (moved.length) {
        webStopped = true;
        await controlService('stop', services[1]);
        if (!frontendOnly) {
          await controlService('stop', services[0]);
          hubStopped = true;
        }
        for (const part of moved.toReversed()) {
          const live = join(projectDirectory, part, 'dist');
          await rm(live, { recursive: true, force: true });
          await rename(join(release.previousDirectory, part), live);
        }
        await record('rolled-back');
      }
    } catch {
      recoveryFailed = true;
      throw new Error(`自动恢复未完成，保留发布门禁；请按 ${release.releaseDirectory}/release.json ${frontendOnly ? '恢复 frontend/dist，确认 Hub 正常并启动 Web' : '恢复两端 dist，再启动服务'}后执行 unblock`);
    }
    throw error;
  } finally {
    try {
      if (!recoveryFailed) {
        try {
          if (!finished && gated) {
            if (hubStopped) await controlService('start', services[0]);
            await healthCheck();
            if (webStopped) await controlService('start', services[1]);
            await webCheck();
          }
          if (gated) removeGate(database);
        } catch (error) {
          throw new Error(`服务恢复或门禁清理未完成，请检查 ${release.releaseDirectory}/release.json 和两端服务，确认正常后执行 unblock：${error.message}`);
        }
      }
    } finally { database.close(); }
  }
  if (finished) console.log(JSON.stringify({ state: 'published', frontendOnly, releaseId: release.releaseId, backup: release.previousDirectory }));
}

async function underLock() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', join(dataDirectory, 'release.lock'),
      process.execPath, '--no-warnings', script, ...process.argv.slice(2), '--locked'], { stdio: 'inherit' });
    const forward = () => child.kill('SIGTERM');
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.once('error', reject);
    child.once('exit', code => { process.exitCode = code ?? 1; resolvePromise(); });
  });
}

try {
  if (command === 'publish' && process.argv.slice(4).some(flag => !['--locked', '--frontend-only'].includes(flag))) {
    throw new Error('未知发布参数；仅支持 --frontend-only');
  }
  if (command === 'status') console.log(JSON.stringify(await deploymentStatus(dataDirectory)));
  else if (!['publish', 'unblock'].includes(command)) throw new Error('用法：node deploy/release.mjs status | publish <staging目录> [--frontend-only] | unblock');
  else if (command === 'publish' && (!argument || argument.startsWith('--'))) throw new Error('publish 需要含 backend/ 和 frontend/ 构建结果的 staging 目录');
  else if (!locked) await underLock();
  else if (command === 'publish') await publish(argument);
  else {
    const database = openDatabase(dataDirectory, false);
    try { const count = gateCount(database); removeGate(database); console.log(JSON.stringify({ state: 'unblocked', removedTriggers: count })); }
    finally { database.close(); }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
