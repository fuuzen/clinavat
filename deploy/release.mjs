import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredDataDirectory, databasePath, environmentFilePath, installDirectory, loadEnvironment, releaseRoot } from './environment.mjs';
import { activityCounts, controlService, deploymentStatus, gateCount, hasActivity, hasRuntimeActivity, installGate,
  openDatabase, removeGate, runtimeCounts, runUserSystemd, services, serviceState } from './release-state.mjs';

const script = fileURLToPath(import.meta.url);
const projectDirectory = dirname(dirname(script));
// A scheduled release inherits the caller's own settings, never the Hub's secrets from the environment file.
const invokingEnvironment = { ...process.env };
loadEnvironment(environmentFilePath());
const dataDirectory = configuredDataDirectory(projectDirectory);
const liveDirectory = installDirectory();
const command = process.argv[2] ?? 'status';
const argument = process.argv[3];
const locked = process.argv.includes('--locked');
const frontendOnly = process.argv.includes('--frontend-only');
const waitWhenBusy = process.argv.includes('--wait');
const inBackground = process.argv.includes('--in-background');
const releaseParts = frontendOnly ? ['frontend'] : ['backend', 'frontend'];
// A busy deployment hands `publish --wait` to this transient unit, which outlives the shell that scheduled it.
const waiterUnit = 'clinavat-release-wait.service';
const waitInterval = 15000;
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
  const live = join(liveDirectory, 'backend', 'dist');
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
  const releaseDirectory = join(releaseRoot(), releaseId);
  const nextDirectory = join(releaseDirectory, 'next');
  const previousDirectory = join(releaseDirectory, 'previous');
  for (const part of ['backend', 'frontend']) {
    const live = join(liveDirectory, part, 'dist');
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
    if ((await stat(join(liveDirectory, part))).dev !== device) throw new Error('发布备份与在线 dist 必须位于同一文件系统');
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
  if (!argumentsList.includes(join(liveDirectory, 'backend', 'dist', 'server.js'))) throw new Error('Hub 未从安装目录运行，请先执行 host:install');
  const openedDatabasePath = await realpath(databasePath(dataDirectory));
  const descriptors = await readdir(`/proc/${hub.MainPID}/fd`);
  const targets = await Promise.all(descriptors.map(descriptor => readlink(`/proc/${hub.MainPID}/fd/${descriptor}`).catch(() => '')));
  if (!targets.includes(openedDatabasePath)) throw new Error('当前配置数据库与在线 Hub 实际打开的数据库不一致');
}

function reachableHost(value) {
  return value === '0.0.0.0' ? '127.0.0.1' : value === '::' ? '[::1]' : value.includes(':') ? `[${value}]` : value;
}

function hubHealthUrl() {
  const host = reachableHost(process.env.CLINAVAT_HOST ?? '127.0.0.1');
  return `http://${host}:${process.env.CLINAVAT_PORT ?? '3001'}/api/health`;
}

async function webCheck() {
  const host = reachableHost(process.env.CLINAVAT_WEB_BIND ?? '127.0.0.1');
  const expected = await readFile(join(liveDirectory, 'frontend', 'dist', 'index.html'), 'utf8');
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
  const address = hubHealthUrl();
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

// Sending SIGUSR2 to a legacy Hub without a handler terminates the process (exit 140) and its cgroup.
async function probeIdleReclaimSupport() {
  try {
    const response = await fetch(hubHealthUrl(), { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { supported: false, reason: `健康检查返回 HTTP ${response.status}` };
    const payload = await response.json();
    if (payload?.status !== 'ok') return { supported: false, reason: '健康检查未返回 status=ok' };
    if (payload.reclaimIdleSignal === 'SIGUSR2') return { supported: true };
    return { supported: false, reason: '在线 Hub 健康检查未声明 SIGUSR2 空闲回收能力（可能为旧版本）' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { supported: false, reason: `无法探测在线 Hub 健康检查（${reason}）` };
  }
}

async function signalIdleReclaim() {
  const hub = await serviceState(services[0]);
  if (hub.ActiveState !== 'active' || !hub.MainPID || hub.MainPID === '0') return false;
  const pid = Number(hub.MainPID);
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const probe = await probeIdleReclaimSupport();
  if (!probe.supported) {
    console.error(`跳过向 Hub (PID ${pid}) 发送 SIGUSR2：${probe.reason}`);
    return false;
  }
  try {
    process.kill(pid, 'SIGUSR2');
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function reclaimIdleHubProcesses(initial) {
  if (!await signalIdleReclaim()) return initial;
  const deadline = Date.now() + 5000;
  let latest = initial;
  while (Date.now() < deadline) {
    if (cancelled) break;
    await delay(500);
    latest = await deploymentStatus(dataDirectory);
    if (hasActivity(latest) || (!latest.runtimeJournals && !latest.conversationProcesses)) break;
  }
  return latest;
}

async function drainPreparations(database) {
  const deadline = Date.now() + 45000;
  let cleanSamples = 0;
  let signaledReclaim = false;
  while (Date.now() < deadline) {
    checkCancelled();
    const activity = activityCounts(database);
    if (hasActivity(activity)) throw retryLater('发布门禁后仍检测到活跃对话，已中止发布');
    const runtime = await runtimeCounts(database, dataDirectory, await serviceState(services[0]));
    if (!signaledReclaim && (runtime.runtimeJournals > 0 || runtime.conversationProcesses > 0)) {
      signaledReclaim = true;
      await signalIdleReclaim().catch(() => false);
    }
    cleanSamples = hasRuntimeActivity(runtime, !frontendOnly) ? 0 : cleanSamples + 1;
    if (cleanSamples >= 2) return;
    await delay(500);
  }
  throw retryLater('账号准备、额度查询或凭据回收尚未结束，保留原部署，请稍后重试');
}

/** Nothing was switched yet: the deployment stays as it was, and a later attempt may succeed. */
function retryLater(message) {
  return Object.assign(new Error(message), { exitCode: 75 });
}

async function publish(staging) {
  let initial = await deploymentStatus(dataDirectory);
  // Conversations may have ended while their resident CLIs are still in the idle grace period.
  if (!hasActivity(initial) && (initial.runtimeJournals > 0 || initial.conversationProcesses > 0)) {
    initial = await reclaimIdleHubProcesses(initial);
  }
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
      const live = join(liveDirectory, part, 'dist');
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
          const live = join(liveDirectory, part, 'dist');
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

/** Resolves to the locked run's exit code; 75 when the deployment was busy or another release held the lock. */
async function underLock() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', join(dataDirectory, 'release.lock'),
      process.execPath, '--no-warnings', script, ...process.argv.slice(2), '--locked'], { stdio: 'inherit' });
    const forward = () => child.kill('SIGTERM');
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const release = () => { process.off('SIGINT', forward); process.off('SIGTERM', forward); };
    child.once('error', error => { release(); reject(error); });
    child.once('exit', code => { release(); resolvePromise(code ?? 1); });
  });
}

async function pendingRelease() {
  const waiter = await serviceState(waiterUnit, 'ActiveState,Description,ActiveEnterTimestamp');
  return ['active', 'activating', 'deactivating', 'reloading'].includes(waiter.ActiveState)
    ? { state: waiter.ActiveState, description: waiter.Description, since: waiter.ActiveEnterTimestamp } : null;
}

async function scheduleRelease(staging) {
  // Values are copied from systemd-run's own environment, so none of them appear on a command line.
  const names = Object.keys(invokingEnvironment).filter(name => name === 'PATH' || name.startsWith('CLINAVAT_') || /^XDG_[A-Z]+_HOME$/.test(name));
  try {
    await runUserSystemd('systemd-run', ['--quiet', '--collect', `--unit=${waiterUnit}`,
      `--description=等待空闲后发布 ${staging}${frontendOnly ? '（仅前端）' : ''}`,
      // Stopping the unit cancels like Ctrl-C: only the waiter is signalled, and it has time to roll back.
      '--property=KillMode=mixed', '--property=TimeoutStopSec=300', ...names.map(name => `--setenv=${name}`),
      '--', process.execPath, '--no-warnings', script, 'publish', staging, ...(frontendOnly ? ['--frontend-only'] : []), '--in-background'],
    { env: invokingEnvironment, timeout: 30000 });
  } catch (error) { throw new Error(`无法创建后台发布任务：${(error.stderr || error.message).trim()}`); }
}

async function waitAndPublish(staging) {
  console.log(`等待空闲后发布 ${staging}${frontendOnly ? '（仅前端）' : ''}`);
  for (;;) {
    let idle = false;
    try {
      let status = await deploymentStatus(dataDirectory);
      if (!hasActivity(status) && (status.runtimeJournals > 0 || status.conversationProcesses > 0)) {
        status = await reclaimIdleHubProcesses(status);
      }
      idle = !hasActivity(status) && !hasRuntimeActivity(status, !frontendOnly);
    } catch (error) { console.error(`检查部署状态失败，稍后重试：${error.message}`); }
    // The locked run checks again and gates atomically; 75 means work started in between.
    if (idle) {
      const code = await underLock();
      if (code !== 75) return code;
    }
    for (let waited = 0; waited < waitInterval; waited += 1000) {
      if (cancelled) throw new Error('已取消等待中的发布');
      await delay(1000);
    }
  }
}

async function cancelPendingRelease() {
  if (!await pendingRelease()) { console.log(JSON.stringify({ state: 'none' })); return; }
  // A release already under way rolls back first, within the unit's stop timeout.
  try { await runUserSystemd('systemctl', ['stop', waiterUnit], { timeout: 330000 }); }
  catch { throw new Error(`${waiterUnit} 停止未完成，请检查 systemd 服务状态`); }
  console.log(JSON.stringify({ state: 'cancelled' }));
}

try {
  if (command === 'publish' && process.argv.slice(4).some(flag => !['--locked', '--frontend-only', '--wait', '--in-background'].includes(flag))) {
    throw new Error('未知发布参数；仅支持 --frontend-only 和 --wait');
  }
  if (command === 'status') console.log(JSON.stringify({ ...await deploymentStatus(dataDirectory), pendingRelease: await pendingRelease() }));
  else if (command === 'cancel') await cancelPendingRelease();
  else if (!['publish', 'unblock'].includes(command)) throw new Error('用法：node deploy/release.mjs status | publish <staging目录> [--frontend-only] [--wait] | cancel | unblock');
  else if (command === 'publish' && (!argument || argument.startsWith('--'))) throw new Error('publish 需要含 backend/ 和 frontend/ 构建结果的 staging 目录');
  else if (locked) {
    if (command === 'publish') await publish(argument);
    else {
      const database = openDatabase(dataDirectory, false);
      try { const count = gateCount(database); removeGate(database); console.log(JSON.stringify({ state: 'unblocked', removedTriggers: count })); }
      finally { database.close(); }
    }
  } else if (command === 'unblock') process.exitCode = await underLock();
  else if (inBackground) process.exitCode = await waitAndPublish(argument);
  else {
    // A waiting release would otherwise replace this one as soon as the deployment is idle.
    const pending = await pendingRelease();
    if (pending) throw new Error(`已有等待空闲的发布（${pending.description}）；先执行 cancel 再发布`);
    const staging = await realpath(resolve(argument));
    const code = await underLock();
    if (code === 75 && waitWhenBusy && !cancelled) {
      await stat(join(staging, 'backend', 'server.js'));
      await stat(join(staging, 'frontend', 'index.html'));
      await scheduleRelease(staging);
      console.log(JSON.stringify({ state: 'scheduled', unit: waiterUnit, staging }));
    } else process.exitCode = code;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
