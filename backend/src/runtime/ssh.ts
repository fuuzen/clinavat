import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionHost } from '../execution/types.js';
import type { DevHostApproval, DevHostApprovalStore } from './dev-host-approvals.js';
import { KeyStore } from './keys.js';
import { atomicWrite, checkedCommand, runCommand } from './process.js';
import {
  mergeKnownHostLines, runIsolatedHandshake, temporaryContainerKnownHostsPath,
} from './ssh-probe.js';
import {
  buildConnectProxyCommand, buildProbeProxyCommand, ensureSshRelayClient,
} from './ssh-relay-client.js';
import { relayBindHost, type SshRelayHop, type SshRelayServer } from './ssh-relay.js';
import { isPrivateIpv4, type SshTargetPolicy } from './target-policy.js';
import { assertHostOwner, assertRemotePath, remoteBash, shellQuote, type DevHost, type RuntimeConfig } from './types.js';

const pendingApprovalProbeMessage =
  '该内网开发机尚未获得管理员审批，已提交审批申请，请联系管理员在「网关 / 内网开发机审批」面板批准后再测试。';
const pendingApprovalConnectMessage =
  '该内网开发机尚未获得管理员审批，已提交审批申请，请联系管理员在「网关 / 内网开发机审批」面板批准后再连接。';

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
  proxyCommand?: string;
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
    ...(options.proxyCommand ? [`  ProxyCommand ${options.proxyCommand}`] : []),
    ...(options.proxyJump ? [`  ProxyJump ${options.proxyJump}`] : []), '',
  ].join('\n');
}

export interface HostProbeKeys {
  privateKey?: string;
  jumpPrivateKey?: string;
  /** A saved host whose stored keys stand in for keys the probe does not replace. */
  savedHostId?: string;
}

export interface HostConnectionResult {
  ok: boolean;
  status?: 'CONNECTED';
  pendingApproval?: boolean;
  approval?: DevHostApproval;
  fingerprint?: string;
  jumpFingerprint?: string;
  viaRelay?: boolean;
  message?: string;
}

export interface SshManagerDependencies {
  execution?: ExecutionHost;
  policy?: SshTargetPolicy;
  approvals?: DevHostApprovalStore;
  relay?: SshRelayServer;
  vmBridge?: string;
  sshRelayPort?: number;
}

export class SshManager {
  readonly keys: KeyStore;
  private readonly masters = new Map<string, { userId: string; host: DevHost }>();
  private readonly execution?: ExecutionHost;
  private readonly policy?: SshTargetPolicy;
  private readonly approvals?: DevHostApprovalStore;
  private readonly vmBridge: string;
  private readonly sshRelayPort: number;
  private relay?: SshRelayServer;

  constructor(readonly config: RuntimeConfig, deps: SshManagerDependencies = {}) {
    this.keys = new KeyStore(config);
    this.execution = deps.execution;
    this.policy = deps.policy;
    this.approvals = deps.approvals;
    this.relay = deps.relay;
    this.vmBridge = deps.vmBridge ?? '10.31.0.1/24';
    this.sshRelayPort = deps.sshRelayPort ?? 22100;
  }

  setRelay(relay: SshRelayServer): void { this.relay = relay; }

  private get isLxd(): boolean { return this.execution?.kind === 'vm'; }
  private relayHost(): string { return this.relay?.bindHost ?? relayBindHost(this.vmBridge); }
  private relayPort(): number { return this.relay?.port ?? this.sshRelayPort; }

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

  private firstHop(host: DevHost): { hop: SshRelayHop; endpoint: DevHost } {
    const jump = this.jumpHost(host);
    return jump ? { hop: 'jump', endpoint: jump } : { hop: 'target', endpoint: host };
  }

  private shouldUseRelay(userId: string, hostId: string, hop: SshRelayHop, hostname: string, port: number): boolean {
    if (!this.isLxd) return false;
    if (isIPv4(hostname)) return isPrivateIpv4(hostname);
    return this.approvals?.hasPrivateRecord(userId, hostname, port, hostId, hop) ?? false;
  }

  async addHost(
    userId: string,
    host: DevHost,
    privateKey?: string,
    jumpPrivateKey?: string,
    options?: { useRelay?: boolean },
  ): Promise<void> {
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
      await mkdir(configDirectory, { recursive: true, mode: 0o700 });
      await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
      await atomicWrite(this.configPath(userId), `Include ${configQuote(join(configDirectory, '*.conf'))}\n`);

      const first = this.firstHop(host);
      const useRelay = this.isLxd && (options?.useRelay ?? this.shouldUseRelay(userId, host.id, first.hop, first.endpoint.host, first.endpoint.port));
      const proxyCommand = useRelay
        ? buildConnectProxyCommand(await ensureSshRelayClient(directory, this.relayHost(), this.relayPort()), host.id, first.hop)
        : undefined;

      const blocks = [];
      for (const endpoint of [host, ...(jump ? [jump] : [])]) {
        const controlPath = join(controlDirectory, createHash('sha256').update(`${userId}:${endpoint.id}`).digest('hex').slice(0, 24));
        if (Buffer.byteLength(controlPath) > 95) throw new Error('DATA_DIR 路径过长，无法创建 SSH 连接复用套接字');
        blocks.push(endpointConfig(this.alias(endpoint), endpoint, {
          identity: await this.keys.identityPath(userId, endpoint.id),
          knownHosts: this.knownHostsPath(userId),
          hostKeyChecking: 'yes',
          controlPath,
          proxyCommand: endpoint.id === first.endpoint.id ? proxyCommand : undefined,
          proxyJump: endpoint.id === host.id && jump ? this.alias(jump) : undefined,
        }));
      }
      await atomicWrite(join(configDirectory, `${host.id}.conf`), blocks.join('\n'));
    });
  }

  async connect(userId: string, host: DevHost): Promise<HostConnectionResult> {
    assertHostOwner(userId, host);
    const jump = this.jumpHost(host);
    const first = this.firstHop(host);
    const classified = this.policy ? await this.policy.classifyTarget(first.endpoint.host, first.endpoint.port) : undefined;
    if (classified?.kind === 'private' && this.approvals && !this.approvals.findApproved(userId, classified.pinnedIp, classified.port)) {
      const approval = this.approvals.requestOrGet({
        userId, devHostId: host.id, hop: first.hop,
        hostname: first.endpoint.host, pinnedIp: classified.pinnedIp, port: classified.port,
      });
      return { ok: false, pendingApproval: true, approval, viaRelay: this.isLxd, message: pendingApprovalConnectMessage };
    }

    const viaRelay = this.isLxd && classified?.kind === 'private';
    await this.addHost(userId, host, undefined, undefined, { useRelay: viaRelay });
    const tempKnownHosts = this.isLxd
      ? temporaryContainerKnownHostsPath('connect')
      : join(tmpdir(), `clinavat-connect-${randomUUID()}.kh`);
    const bootstrapPath = join(this.keys.directory(userId), `connect-${randomUUID()}.conf`);
    // ProxyJump starts a second ssh process, so both endpoints need this temporary first-use policy and known_hosts.
    await atomicWrite(bootstrapPath, [
      `Host ${[host, ...(jump ? [jump] : [])].map(endpoint => this.alias(endpoint)).join(' ')}`,
      '  StrictHostKeyChecking accept-new',
      `  UserKnownHostsFile ${configQuote(tempKnownHosts)}`,
      '  ControlMaster no',
      '  ControlPath none',
      'Host *',
      `  Include ${configQuote(this.configPath(userId))}`,
      '',
    ].join('\n'));
    let handshake;
    try {
      handshake = await runIsolatedHandshake({
        userId, configPath: bootstrapPath, existingKnownHostsPath: this.knownHostsPath(userId),
        host, alias: this.alias(host), jump, jumpAlias: jump && this.alias(jump),
        sshBinary: this.config.sshBinary ?? 'ssh', sshKeygenBinary: this.config.sshKeygenBinary ?? 'ssh-keygen',
        execution: this.execution, containerKnownHostsPath: tempKnownHosts,
      });
    } catch (error) {
      await this.disconnectHost(userId, host);
      throw error;
    } finally {
      await rm(bootstrapPath, { force: true });
    }
    await mergeKnownHostLines(this.knownHostsPath(userId), [...handshake.hostLines, ...handshake.jumpLines]);
    this.masters.set(`${userId}:${host.id}`, { userId, host });
    return {
      ok: true, status: 'CONNECTED', fingerprint: handshake.fingerprint,
      ...(handshake.jumpFingerprint ? { jumpFingerprint: handshake.jumpFingerprint } : {}),
      viaRelay,
    };
  }

  /** Tests connection settings that may not be saved yet, without touching the host's saved configuration or known_hosts. */
  async probe(userId: string, host: DevHost, keys: HostProbeKeys): Promise<HostConnectionResult> {
    assertHostOwner(userId, host);
    const jump = this.jumpHost(host);
    const first = this.firstHop(host);
    const classified = this.policy ? await this.policy.classifyTarget(first.endpoint.host, first.endpoint.port) : undefined;
    if (classified?.kind === 'private' && this.approvals && !this.approvals.findApproved(userId, classified.pinnedIp, classified.port)) {
      const approval = this.approvals.requestOrGet({
        userId, devHostId: keys.savedHostId ?? null, hop: first.hop,
        hostname: first.endpoint.host, pinnedIp: classified.pinnedIp, port: classified.port,
      });
      return { ok: false, pendingApproval: true, approval, viaRelay: this.isLxd, message: pendingApprovalProbeMessage };
    }

    const viaRelay = this.isLxd && classified?.kind === 'private';
    const generated = await this.ensureUserKey(userId);
    const temporaryFiles: string[] = [];
    const identity = async (privateKey: string | undefined, savedId: string | undefined) => {
      if (!privateKey) return savedId ? this.keys.identityPath(userId, savedId) : generated.privateKeyPath;
      const path = await this.keys.writeTemporaryIdentity(userId, privateKey);
      temporaryFiles.push(path);
      return path;
    };

    const alias = `probe-${randomUUID()}`;
    const directory = this.keys.directory(userId);
    const configPath = join(directory, `${alias}.conf`);
    temporaryFiles.push(configPath);
    const tempKnownHosts = this.isLxd
      ? temporaryContainerKnownHostsPath('probe')
      : join(tmpdir(), `clinavat-probe-${randomUUID()}.kh`);

    let probeToken: string | undefined;
    let probeProxyCommand: string | undefined;
    if (viaRelay && classified) {
      if (!this.relay) throw new Error('SSH 中继服务未就绪');
      const scriptPath = await ensureSshRelayClient(directory, this.relayHost(), this.relayPort());
      probeToken = randomBytes(24).toString('hex');
      this.relay.registerProbeToken(probeToken, {
        userId, pinnedIp: classified.pinnedIp, port: classified.port, ttlMs: 60_000, maxUses: jump ? 2 : 1,
      });
      probeProxyCommand = buildProbeProxyCommand(scriptPath, probeToken);
    }

    try {
      const shared = { knownHosts: tempKnownHosts, hostKeyChecking: 'accept-new' as const };
      await atomicWrite(configPath, [
        endpointConfig(alias, host, {
          ...shared,
          identity: await identity(keys.privateKey, keys.savedHostId),
          proxyCommand: !jump ? probeProxyCommand : undefined,
          proxyJump: jump && `${alias}-jump`,
        }),
        ...(jump ? [endpointConfig(`${alias}-jump`, jump, {
          ...shared,
          identity: await identity(keys.jumpPrivateKey, keys.savedHostId && `${keys.savedHostId}-jump`),
          proxyCommand: probeProxyCommand,
        })] : []),
      ].join('\n'));
      const handshake = await runIsolatedHandshake({
        userId, configPath, existingKnownHostsPath: this.knownHostsPath(userId),
        host, alias, jump, jumpAlias: jump && `${alias}-jump`,
        sshBinary: this.config.sshBinary ?? 'ssh', sshKeygenBinary: this.config.sshKeygenBinary ?? 'ssh-keygen',
        execution: this.execution, containerKnownHostsPath: tempKnownHosts,
      });
      return {
        ok: true, status: 'CONNECTED', fingerprint: handshake.fingerprint,
        ...(handshake.jumpFingerprint ? { jumpFingerprint: handshake.jumpFingerprint } : {}),
        viaRelay,
      };
    } finally {
      if (probeToken) this.relay?.revokeProbeToken(probeToken);
      await Promise.all(temporaryFiles.map(path => rm(path, { force: true })));
    }
  }

  async exec(userId: string, host: DevHost, command: string, timeout = 30_000, maxBytes?: number) {
    assertHostOwner(userId, host);
    const first = this.firstHop(host);
    const classified = this.policy ? await this.policy.classifyTarget(first.endpoint.host, first.endpoint.port) : undefined;
    if (this.isLxd && classified?.kind === 'private' && this.approvals
      && !this.approvals.findApproved(userId, classified.pinnedIp, classified.port)) {
      throw new Error('该内网开发机尚未获得管理员审批，请联系管理员在「网关 / 内网开发机审批」面板批准后再操作。');
    }
    const viaRelay = this.isLxd && classified?.kind === 'private';
    await this.addHost(userId, host, undefined, undefined, { useRelay: viaRelay });
    this.masters.set(`${userId}:${host.id}`, { userId, host });
    if (this.execution?.kind === 'vm') {
      const jump = this.jumpHost(host);
      const execConfigPath = join(this.keys.directory(userId), `exec-${randomUUID()}.conf`);
      // ProxyJump spawns a child ssh that does not inherit target CLI -o flags, so disable ControlMaster in a temporary config.
      await atomicWrite(execConfigPath, [
        `Host ${[host, ...(jump ? [jump] : [])].map(endpoint => this.alias(endpoint)).join(' ')}`,
        '  ControlMaster no',
        '  ControlPath none',
        'Host *',
        `  Include ${configQuote(this.configPath(userId))}`,
        '',
      ].join('\n'));
      try {
        return await this.execution.run(
          'ssh',
          ['-F', execConfigPath, this.alias(host), remoteBash(command)],
          { scope: { userId, paths: [] }, timeout, maxBytes },
        );
      } finally {
        await rm(execConfigPath, { force: true });
      }
    }
    return runCommand(this.config.sshBinary ?? 'ssh', ['-F', this.configPath(userId), this.alias(host), remoteBash(command)], { timeout, maxBytes });
  }

  /** Lists subdirectories of the path, or of the login user's home directory when no path is given. */
  async listDirectories(userId: string, host: DevHost, path?: string): Promise<{ path: string; entries: { name: string; path: string; type: 'directory' }[] }> {
    if (path !== undefined) assertRemotePath(path);
    const command = `cd -- ${path === undefined ? '"$HOME"' : shellQuote(path)} && printf '%s\\0' "$PWD" && find . -mindepth 1 -maxdepth 1 -type d -print0`;
    const result = await this.exec(userId, host, command);
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法读取远端目录');
    const [canonicalPath, ...names] = result.stdout.split('\0');
    return {
      path: canonicalPath || path || '/',
      entries: names.filter(Boolean).map(name => ({
        name: name.replace(/^\.\//, ''),
        path: `${canonicalPath === '/' ? '' : canonicalPath}/${name.replace(/^\.\//, '')}`,
        type: 'directory' as const,
      })).sort((left, right) => left.name.localeCompare(right.name)),
    };
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
    await mkdir(wrapperDirectory, { recursive: true, mode: 0o700 });
    await mkdir(mutagenDirectory, { recursive: true, mode: 0o700 });
    const binaries = [['ssh', this.config.sshBinary ?? 'ssh'], ['scp', this.config.scpBinary ?? 'scp']] as const;
    for (const [name, binary] of binaries) {
      await atomicWrite(join(wrapperDirectory, name), `#!/bin/sh\nexec ${shellQuote(binary)} -F ${shellQuote(this.configPath(userId))} "$@"\n`, 0o700);
    }
    return { MUTAGEN_DATA_DIRECTORY: mutagenDirectory, MUTAGEN_SSH_PATH: wrapperDirectory };
  }

  async deleteHost(userId: string, host: DevHost): Promise<void> {
    assertHostOwner(userId, host);
    await this.disconnectHost(userId, host);
    await rm(join(this.keys.directory(userId), 'config.d', `${host.id}.conf`), { force: true });
    await this.keys.deleteHost(userId, host.id);
    await this.keys.deleteHost(userId, `${host.id}-jump`);
  }

  async disconnectHost(userId: string, host: DevHost): Promise<void> {
    assertHostOwner(userId, host);
    for (const endpoint of [host, ...(this.jumpHost(host) ? [this.jumpHost(host)!] : [])]) {
      await runCommand(this.config.sshBinary ?? 'ssh', ['-F', this.configPath(userId), '-O', 'exit', this.alias(endpoint)], { timeout: 5000 }).catch(() => undefined);
    }
    this.masters.delete(`${userId}:${host.id}`);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.masters.values()].map(({ userId, host }) => this.disconnectHost(userId, host)));
    this.masters.clear();
  }
}
