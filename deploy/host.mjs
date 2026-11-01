import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readdir, readFile, readlink, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvironment as readEnvironment } from './environment.mjs';
import { activateServices, ensureInstallIdle } from './service-install.mjs';
import { discoverServices, services as installedServices } from './release-state.mjs';

const deploymentDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(deploymentDirectory);
const environmentFile = join(projectDirectory, '.env');
const services = ['clinavat-hub.service', 'clinavat-web.service'];
const command = process.argv[2] ?? 'status';

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { ...options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} 退出码：${result.status ?? result.signal}`);
}

function unitValue(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('服务路径或环境变量包含无效字符');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function executableArgument(value) {
  return unitValue(value).replaceAll('$', '$$');
}

function unitPath(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('服务路径包含无效字符');
  return value.replaceAll('\\', '\\\\').replaceAll('%', '%%').replaceAll(' ', '\\x20').replaceAll('\t', '\\t');
}

async function executable(name) {
  const candidates = isAbsolute(name) ? [name]
    : (process.env.PATH ?? '').split(':').map(directory => join(directory, name));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return resolve(candidate); }
    catch { /* Continue searching the configured PATH. */ }
  }
  throw new Error(`找不到可执行程序：${name}，请先安装并加入 PATH`);
}

function loadEnvironment() {
  readEnvironment(environmentFile);
}

async function prepareRuntime() {
  loadEnvironment();
  if (!process.env.XDG_RUNTIME_DIR) throw new Error('需要 systemd 用户会话的 XDG_RUNTIME_DIR');
  const dataDirectory = resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR ?? '../data');
  const runtimeDirectory = process.env.RUNTIME_DIRECTORY ?? join(process.env.XDG_RUNTIME_DIR, 'clinavat');
  const runtimeLink = join(dataDirectory, 'run');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  const existing = await lstat(runtimeLink).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing?.isSymbolicLink()) {
    if (await readlink(runtimeLink) === runtimeDirectory) return;
    await unlink(runtimeLink);
  } else if (existing) {
    if (!existing.isDirectory()) throw new Error('数据目录下的 run 不是目录或符号链接');
    // Never remove a populated runtime directory, which may belong to a live deployment.
    await rmdir(runtimeLink);
  }
  await symlink(runtimeDirectory, runtimeLink);
}

async function resumeSync() {
  loadEnvironment();
  const dataDirectory = resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR ?? '../data');
  const usersDirectory = join(dataDirectory, 'users');
  const users = await readdir(usersDirectory, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  for (const user of users) {
    if (!user.isDirectory()) continue;
    const userDirectory = join(usersDirectory, user.name);
    const mutagenDirectory = join(userDirectory, 'mutagen');
    const metadata = await lstat(mutagenDirectory).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!metadata?.isDirectory()) continue;
    const sessions = await readdir(join(mutagenDirectory, 'sessions'), { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    if (!sessions.some(session => session.isFile())) continue;
    run(process.env.CLINAVAT_MUTAGEN_BIN ?? 'mutagen', ['daemon', 'start'], {
      // The daemon outlives this command; it must not inherit the master key loaded from .env.
      env: {
        ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
        MUTAGEN_DATA_DIRECTORY: mutagenDirectory, MUTAGEN_SSH_PATH: join(userDirectory, 'mutagen-ssh'),
      },
      timeout: 20_000,
    });
  }
}

async function install() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('需要 Node.js 22.13 或更新版本');
  loadEnvironment();
  if (!/^[a-f\d]{64}$/i.test(process.env.CLINAVAT_MASTER_KEY ?? '')) throw new Error('请先配置有效的 CLINAVAT_MASTER_KEY；已有部署必须保留原密钥');
  if (!process.env.XDG_RUNTIME_DIR) throw new Error('需要 systemd 用户会话');
  for (const file of ['backend/dist/server.js', 'frontend/dist/index.html']) await access(join(projectDirectory, file));
  await import('../backend/dist/config.js');
  const caddy = await executable('caddy');
  for (const name of [process.env.CLINAVAT_MUTAGEN_BIN ?? 'mutagen', process.env.CLINAVAT_CLAUDE_BIN ?? 'claude',
    process.env.CLINAVAT_CODEX_BIN ?? 'codex', process.env.CLINAVAT_SSH_BIN ?? 'ssh',
    process.env.CLINAVAT_SSH_KEYGEN_BIN ?? 'ssh-keygen', 'bash', 'git', 'flock', 'scp', 'rg']) await executable(name);
  const environmentPath = [...new Set([dirname(process.execPath), join(homedir(), '.local/bin'),
    ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':');
  const dataDirectory = resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR ?? '../data');
  await ensureInstallIdle(dataDirectory);
  const serviceDirectory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
  await mkdir(serviceDirectory, { recursive: true });
  const node = executableArgument(process.execPath);
  const script = executableArgument(fileURLToPath(import.meta.url));
  const hub = `[Unit]
Description=Clinavat host backend
Conflicts=cc-pool-hub.service
After=network.target cc-pool-hub.service

[Service]
Type=simple
WorkingDirectory=${unitPath(join(projectDirectory, 'backend'))}
Environment=${unitValue(`PATH=${environmentPath}`)}
Environment=NODE_ENV=production
RuntimeDirectory=clinavat
RuntimeDirectoryMode=0700
ExecStartPre=${node} ${script} prepare-runtime
ExecStart=${node} ${executableArgument(`--env-file=${environmentFile}`)} ${executableArgument(join(projectDirectory, 'backend/dist/server.js'))}
ExecStartPost=${node} ${script} resume-sync
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
`;
  const web = `[Unit]
Description=Clinavat host web frontend
Conflicts=cc-pool-web.service
Wants=clinavat-hub.service
After=clinavat-hub.service cc-pool-web.service

[Service]
Type=simple
WorkingDirectory=${unitPath(projectDirectory)}
Environment=${unitValue(`PATH=${environmentPath}`)}
Environment=${unitValue(`CLINAVAT_FRONTEND_DIR=${join(projectDirectory, 'frontend/dist')}`)}
ExecStart=${node} ${script} run-web ${executableArgument(caddy)}
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
`;
  const previous = await Promise.all(services.map(service => readFile(join(serviceDirectory, service)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  })));
  async function restoreUnits() {
    for (const [index, service] of services.entries()) {
      const path = join(serviceDirectory, service);
      if (previous[index]) await writeFile(path, previous[index], { mode: 0o600 });
      else await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    run('systemctl', ['--user', 'daemon-reload']);
  }
  try {
    await writeFile(join(serviceDirectory, services[0]), hub, { mode: 0o600 });
    await writeFile(join(serviceDirectory, services[1]), web, { mode: 0o600 });
    run('systemd-analyze', ['--user', 'verify', ...services.map(service => join(serviceDirectory, service))]);
    run('systemctl', ['--user', 'daemon-reload']);
    await activateServices(dataDirectory, restoreUnits);
  } catch (error) {
    await restoreUnits();
    throw error;
  }
  console.log('Clinavat 宿主服务已安装，旧服务已停用。查看状态：npm run host:status；查看日志：npm run host:logs');
}

function installWithLock() {
  loadEnvironment();
  const dataDirectory = resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR ?? '../data');
  return mkdir(dataDirectory, { recursive: true, mode: 0o700 }).then(() => run('flock', [
    '--nonblock', '--no-fork', '--conflict-exit-code', '75', join(dataDirectory, 'release.lock'),
    process.execPath, fileURLToPath(import.meta.url), 'install', '--locked',
  ]));
}

try {
  if (command === 'install') {
    if (process.argv.includes('--locked')) await install();
    else await installWithLock();
  } else if (command === 'prepare-runtime') await prepareRuntime();
  else if (command === 'resume-sync') await resumeSync();
  else if (command === 'run-web') {
    loadEnvironment();
    run(process.argv[3] ?? 'caddy', ['run', '--config', join(deploymentDirectory, 'clinavat.Caddyfile'), '--adapter', 'caddyfile']);
  } else if (['start', 'stop', 'status', 'logs'].includes(command)) {
    await discoverServices();
    if (command === 'logs') run('journalctl', ['--user', '-u', installedServices[0], '-u', installedServices[1], '-f']);
    else run('systemctl', ['--user', command, ...installedServices, ...(command === 'status' ? ['--no-pager'] : [])]);
  } else throw new Error('用法：node deploy/host.mjs install|start|stop|status|logs');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
