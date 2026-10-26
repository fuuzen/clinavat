import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readdir, readlink, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const deploymentDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(deploymentDirectory);
const environmentFile = join(projectDirectory, '.env');
const services = ['cc-pool-hub.service', 'cc-pool-web.service'];
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
  process.loadEnvFile(environmentFile);
}

async function prepareRuntime() {
  loadEnvironment();
  if (!process.env.XDG_RUNTIME_DIR) throw new Error('需要 systemd 用户会话的 XDG_RUNTIME_DIR');
  const dataDirectory = resolve(projectDirectory, 'backend', process.env.CC_POOL_DATA_DIR ?? '../data');
  const runtimeDirectory = join(process.env.XDG_RUNTIME_DIR, 'cc-pool');
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
  const dataDirectory = resolve(projectDirectory, 'backend', process.env.CC_POOL_DATA_DIR ?? '../data');
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
    run(process.env.CC_POOL_MUTAGEN_BIN ?? 'mutagen', ['daemon', 'start'], {
      env: { ...process.env, MUTAGEN_DATA_DIRECTORY: mutagenDirectory, MUTAGEN_SSH_PATH: join(userDirectory, 'mutagen-ssh') },
      timeout: 20_000,
    });
  }
}

async function install() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('需要 Node.js 22.13 或更新版本');
  loadEnvironment();
  if (!/^[a-f\d]{64}$/i.test(process.env.CC_POOL_MASTER_KEY ?? '')) throw new Error('请先配置有效的 CC_POOL_MASTER_KEY');
  if (!process.env.CC_POOL_ORIGIN) throw new Error('请将 CC_POOL_ORIGIN 配置为浏览器实际访问地址');
  new URL(process.env.CC_POOL_ORIGIN);
  if (!process.env.XDG_RUNTIME_DIR) throw new Error('需要 systemd 用户会话');
  for (const file of ['backend/dist/server.js', 'frontend/dist/index.html']) await access(join(projectDirectory, file));
  const caddy = await executable('caddy');
  for (const name of [process.env.CC_POOL_MUTAGEN_BIN ?? 'mutagen', process.env.CC_POOL_CLAUDE_BIN ?? 'claude',
    process.env.CC_POOL_CODEX_BIN ?? 'codex', process.env.CC_POOL_SSH_BIN ?? 'ssh',
    process.env.CC_POOL_SSH_KEYGEN_BIN ?? 'ssh-keygen', 'bash', 'git', 'flock', 'scp', 'rg']) await executable(name);
  const environmentPath = [...new Set([dirname(process.execPath), join(homedir(), '.local/bin'),
    ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':');
  const serviceDirectory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
  await mkdir(serviceDirectory, { recursive: true });
  const node = executableArgument(process.execPath);
  const script = executableArgument(fileURLToPath(import.meta.url));
  const environment = executableArgument(environmentFile);
  const hub = `[Unit]
Description=CC-Pool host backend
After=network.target

[Service]
Type=simple
WorkingDirectory=${unitPath(join(projectDirectory, 'backend'))}
Environment=${unitValue(`PATH=${environmentPath}`)}
Environment=NODE_ENV=production
RuntimeDirectory=cc-pool
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
Description=CC-Pool host web frontend
Wants=cc-pool-hub.service
After=cc-pool-hub.service

[Service]
Type=simple
WorkingDirectory=${unitPath(projectDirectory)}
Environment=${unitValue(`CC_POOL_FRONTEND_DIR=${join(projectDirectory, 'frontend/dist')}`)}
ExecStart=${executableArgument(caddy)} run --envfile ${environment} --config ${executableArgument(join(deploymentDirectory, 'Caddyfile'))} --adapter caddyfile
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
`;
  await writeFile(join(serviceDirectory, services[0]), hub, { mode: 0o600 });
  await writeFile(join(serviceDirectory, services[1]), web, { mode: 0o600 });
  run('systemd-analyze', ['--user', 'verify', ...services.map(service => join(serviceDirectory, service))]);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', ...services]);
  run('systemctl', ['--user', 'restart', ...services]);
  console.log('宿主服务已安装。查看状态：npm run host:status；查看日志：npm run host:logs');
}

try {
  if (command === 'install') await install();
  else if (command === 'prepare-runtime') await prepareRuntime();
  else if (command === 'resume-sync') await resumeSync();
  else if (command === 'logs') run('journalctl', ['--user', '-u', services[0], '-u', services[1], '-f']);
  else if (['start', 'stop', 'status'].includes(command)) run('systemctl', ['--user', command, ...services, ...(command === 'status' ? ['--no-pager'] : [])]);
  else throw new Error('用法：node deploy/host.mjs install|start|stop|status|logs');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
