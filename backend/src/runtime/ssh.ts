import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyStore } from './keys.js';
import { atomicWrite, checkedCommand, runCommand } from './process.js';
import { assertHostOwner, assertRemotePath, remoteBash, shellQuote, type DevHost, type RuntimeConfig } from './types.js';

function configQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('SSH 配置包含无效字符');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface EndpointConfig {
  identity: string;
  knownHosts: string;
  hostKeyChecking: 'yes' | 'accept-new';
  controlPath?: string;
  proxyJump?: string;
}

function endpointConfig(alias: string, endpoint: DevHost, options: EndpointConfig): string {
  return [
    `Host ${alias}`,
    `  HostName ${endpoint.host}`, `  Port ${endpoint.port}`, `  User ${endpoint.username}`,
    `  IdentityFile ${configQuote(options.identity)}`, '  IdentitiesOnly yes', '  BatchMode yes',
    `  UserKnownHostsFile ${configQuote(options.knownHosts)}`, '  GlobalKnownHostsFile /dev/null',
    `  StrictHostKeyChecking ${options.hostKeyChecking}`, '  HashKnownHosts yes', '  ConnectTimeout 10',
    ...(options.controlPath
      ? ['  ControlMaster auto', `  ControlPath ${configQuote(options.controlPath)}`, '  ControlPersist 600']
      : ['  ControlMaster no', '  ControlPath none']),
    '  ServerAliveInterval 30', '  ServerAliveCountMax 3', '  LogLevel ERROR',
    ...(options.proxyJump ? [`  ProxyJump ${options.proxyJump}`] : []), '',
  ].join('\n');
}

function endpointAddress(endpoint: DevHost): string {
  return `${endpoint.username}@${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
}

export interface HostProbeKeys {
  privateKey?: string;
  jumpPrivateKey?: string;
  /** A saved host whose stored keys stand in for keys the probe does not replace. */
  savedHostId?: string;
}

export class SshManager {
  readonly keys: KeyStore;
  private readonly masters = new Map<string, {userId: string; host: DevHost}>();

  constructor(readonly config: RuntimeConfig) { this.keys = new KeyStore(config); }

  ensureUserKey(userId: string) { return this.keys.ensureUserKey(userId); }
  configPath(userId: string): string { return join(this.keys.directory(userId), 'config'); }
  knownHostsPath(userId: string): string { return join(this.keys.directory(userId), 'known_hosts'); }
  alias(host: DevHost): string { return `devhost-${host.id}`; }

  jumpHost(host: DevHost): DevHost | undefined {
    if (!host.jump_host) return undefined;
    return {
      id: `${host.id}-jump`, user_id: host.user_id, name: `${host.name} 跳板机`,
      host: host.jump_host, port: host.jump_port!, username: host.jump_username!,
    };
  }

  async addHost(userId: string, host: DevHost, privateKey?: string, jumpPrivateKey?: string): Promise<void> {
    assertHostOwner(userId, host);
    const jump = this.jumpHost(host);
    if (jumpPrivateKey && !jump) throw new Error('请先配置跳板机，再导入其私钥');
    await Promise.all([privateKey, jumpPrivateKey].filter((key): key is string => !!key)
      .map(key => this.keys.validatePrivateKey(userId, key)));
    await this.ensureUserKey(userId);
    const keyIds = [...(privateKey ? [host.id] : []), ...(jumpPrivateKey && jump ? [jump.id] : [])];
    await this.keys.withHostKeyRollback(userId, keyIds, async () => {
      if (privateKey) await this.keys.importHostKey(userId, host.id, privateKey);
      if (jump && jumpPrivateKey) await this.keys.importHostKey(userId, jump.id, jumpPrivateKey);
      const directory = this.keys.directory(userId);
      const configDirectory = join(directory, 'config.d');
      const controlDirectory = join(this.config.dataDir, 'run', 'cm');
      await mkdir(configDirectory, {recursive: true, mode: 0o700});
      await mkdir(controlDirectory, {recursive: true, mode: 0o700});
      await atomicWrite(this.configPath(userId), `Include ${configQuote(join(configDirectory, '*.conf'))}\n`);
      const blocks = [];
      for (const endpoint of [host, ...(jump ? [jump] : [])]) {
        const controlPath = join(controlDirectory, createHash('sha256').update(`${userId}:${endpoint.id}`).digest('hex').slice(0, 24));
        if (Buffer.byteLength(controlPath) > 95) throw new Error('DATA_DIR 路径过长，无法创建 SSH 连接复用套接字');
        blocks.push(endpointConfig(this.alias(endpoint), endpoint, {
          identity: await this.keys.identityPath(userId, endpoint.id), knownHosts: this.knownHostsPath(userId),
          hostKeyChecking: 'yes', controlPath,
          proxyJump: endpoint.id === host.id && jump ? this.alias(jump) : undefined,
        }));
      }
      await atomicWrite(join(configDirectory, `${host.id}.conf`), blocks.join('\n'));
    });
  }

  async connect(userId: string, host: DevHost): Promise<{status: string; fingerprint: string; jumpFingerprint?: string}> {
    await this.addHost(userId, host);
    const jump = this.jumpHost(host);
    const bootstrapPath = join(this.keys.directory(userId), `connect-${randomUUID()}.conf`);
    // ProxyJump starts a second ssh process, so both endpoints need this temporary first-use policy.
    await atomicWrite(bootstrapPath, [
      `Host ${[host, ...(jump ? [jump] : [])].map(endpoint => this.alias(endpoint)).join(' ')}`,
      '  StrictHostKeyChecking accept-new', 'Host *', `  Include ${configQuote(this.configPath(userId))}`, '',
    ].join('\n'));
    try {
      await this.handshake(bootstrapPath, host, this.alias(host), jump && this.alias(jump));
    } catch (error) {
      await this.disconnectHost(userId, host);
      throw error;
    } finally { await rm(bootstrapPath, {force: true}); }
    this.masters.set(`${userId}:${host.id}`, {userId, host});
    return {status: 'CONNECTED', ...await this.fingerprints(userId, host)};
  }

  /** Tests connection settings that may not be saved yet, without touching the host's saved configuration or connection. */
  async probe(userId: string, host: DevHost, keys: HostProbeKeys): Promise<{fingerprint: string; jumpFingerprint?: string}> {
    assertHostOwner(userId, host);
    const jump = this.jumpHost(host);
    const generated = await this.ensureUserKey(userId);
    const temporaryFiles: string[] = [];
    const identity = async (privateKey: string | undefined, savedId: string | undefined) => {
      if (!privateKey) return savedId ? this.keys.identityPath(userId, savedId) : generated.privateKeyPath;
      const path = await this.keys.writeTemporaryIdentity(userId, privateKey);
      temporaryFiles.push(path);
      return path;
    };
    const alias = `probe-${randomUUID()}`;
    const configPath = join(this.keys.directory(userId), `${alias}.conf`);
    temporaryFiles.push(configPath);
    try {
      const options = {knownHosts: this.knownHostsPath(userId), hostKeyChecking: 'accept-new' as const};
      await atomicWrite(configPath, [
        endpointConfig(alias, host, {
          ...options, identity: await identity(keys.privateKey, keys.savedHostId), proxyJump: jump && `${alias}-jump`,
        }),
        ...(jump ? [endpointConfig(`${alias}-jump`, jump, {
          ...options, identity: await identity(keys.jumpPrivateKey, keys.savedHostId && `${keys.savedHostId}-jump`),
        })] : []),
      ].join('\n'));
      await this.handshake(configPath, host, alias, jump && `${alias}-jump`);
    } finally { await Promise.all(temporaryFiles.map(path => rm(path, {force: true}))); }
    return this.fingerprints(userId, host);
  }

  /** Reaches the jump host on its own first, so a failure names the machine that refused the connection. */
  private async handshake(configPath: string, host: DevHost, alias: string, jumpAlias?: string): Promise<void> {
    const jump = this.jumpHost(host);
    const attempt = async (target: string, heading: string, timeout: number) => {
      try { await checkedCommand(this.config.sshBinary ?? 'ssh', ['-F', configPath, target, 'true'], {timeout}); }
      catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        // At LogLevel ERROR the jump host's refusal to open the forwarded connection is reported only as this line.
        const hint = jump && output.includes('stdio forwarding failed') ? '\n跳板机已连接，但无法访问开发机地址和端口，请确认开发机地址填写的是跳板机可访问的地址，且端口已开放。' : '';
        throw new Error(`${heading}：\n${output}${hint}`);
      }
    };
    if (jump && jumpAlias) await attempt(jumpAlias, `跳板机 ${endpointAddress(jump)} 连接失败`, 20_000);
    await attempt(alias, `开发机 ${endpointAddress(host)} ${jump ? '经跳板机连接失败' : '连接失败'}`, jump ? 35_000 : 20_000);
  }

  private async fingerprints(userId: string, host: DevHost): Promise<{fingerprint: string; jumpFingerprint?: string}> {
    const jump = this.jumpHost(host);
    const fingerprint = (values: Buffer[]) => values.map(key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`).join(', ');
    return {
      fingerprint: fingerprint(await this.knownHostKeys(userId, host)),
      ...(jump ? {jumpFingerprint: fingerprint(await this.knownHostKeys(userId, jump))} : {}),
    };
  }

  async exec(userId: string, host: DevHost, command: string, timeout = 30_000, maxBytes?: number) {
    await this.addHost(userId, host);
    this.masters.set(`${userId}:${host.id}`, {userId, host});
    return runCommand(this.config.sshBinary ?? 'ssh', ['-F', this.configPath(userId), this.alias(host), remoteBash(command)], {timeout, maxBytes});
  }

  /** Lists subdirectories of the path, or of the login user's home directory when no path is given. */
  async listDirectories(userId: string, host: DevHost, path?: string): Promise<{path: string; entries: {name: string; path: string; type: 'directory'}[]}> {
    if (path !== undefined) assertRemotePath(path);
    const command = `cd -- ${path === undefined ? '"$HOME"' : shellQuote(path)} && printf '%s\\0' "$PWD" && find . -mindepth 1 -maxdepth 1 -type d -print0`;
    const result = await this.exec(userId, host, command);
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取远端目录');
    const [canonicalPath, ...names] = result.stdout.split('\0');
    return {path: canonicalPath || path || '/', entries: names.filter(Boolean).map(name => ({
      name: name.replace(/^\.\//, ''), path: `${canonicalPath === '/' ? '' : canonicalPath}/${name.replace(/^\.\//, '')}`, type: 'directory' as const,
    })).sort((left, right) => left.name.localeCompare(right.name))};
  }

  async knownHostKeys(userId: string, host: DevHost): Promise<Buffer[]> {
    assertHostOwner(userId, host);
    const target = host.port === 22 ? host.host : `[${host.host}]:${host.port}`;
    const result = await checkedCommand(this.config.sshKeygenBinary ?? 'ssh-keygen', ['-F', target, '-f', this.knownHostsPath(userId)]);
    return result.stdout.split('\n').filter(line => line && !line.startsWith('#') && !line.startsWith('@')).map(line => {
      const fields = line.trim().split(/\s+/);
      return Buffer.from(fields[2] ?? '', 'base64');
    }).filter(key => key.length > 0);
  }

  async terminalIdentity(userId: string, host: DevHost): Promise<Buffer> {
    assertHostOwner(userId, host);
    return readFile(await this.keys.identityPath(userId, host.id));
  }

  async mutagenEnvironment(userId: string): Promise<NodeJS.ProcessEnv> {
    await this.ensureUserKey(userId);
    const directory = join(this.config.dataDir, 'users', userId);
    const wrapperDirectory = join(directory, 'mutagen-ssh');
    const mutagenDirectory = join(directory, 'mutagen');
    await mkdir(wrapperDirectory, {recursive: true, mode: 0o700});
    await mkdir(mutagenDirectory, {recursive: true, mode: 0o700});
    const binaries = [['ssh', this.config.sshBinary ?? 'ssh'], ['scp', this.config.scpBinary ?? 'scp']] as const;
    for (const [name, binary] of binaries) {
      await atomicWrite(join(wrapperDirectory, name), `#!/bin/sh\nexec ${shellQuote(binary)} -F ${shellQuote(this.configPath(userId))} "$@"\n`, 0o700);
    }
    return {MUTAGEN_DATA_DIRECTORY: mutagenDirectory, MUTAGEN_SSH_PATH: wrapperDirectory};
  }

  async deleteHost(userId: string, host: DevHost): Promise<void> {
    assertHostOwner(userId, host);
    await this.disconnectHost(userId, host);
    await rm(join(this.keys.directory(userId), 'config.d', `${host.id}.conf`), {force: true});
    await this.keys.deleteHost(userId, host.id);
    await this.keys.deleteHost(userId, `${host.id}-jump`);
  }

  async disconnectHost(userId: string, host: DevHost): Promise<void> {
    assertHostOwner(userId, host);
    for (const endpoint of [host, ...(this.jumpHost(host) ? [this.jumpHost(host)!] : [])]) {
      await runCommand(this.config.sshBinary ?? 'ssh', ['-F', this.configPath(userId), '-O', 'exit', this.alias(endpoint)], {timeout: 5000}).catch(() => undefined);
    }
    this.masters.delete(`${userId}:${host.id}`);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.masters.values()].map(({userId, host}) => this.disconnectHost(userId, host)));
    this.masters.clear();
  }
}
