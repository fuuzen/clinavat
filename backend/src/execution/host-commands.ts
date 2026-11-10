import { chmod, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { KeyStore } from '../runtime/keys.js';
import { atomicWrite, checkedCommand } from '../runtime/process.js';
import { renderHostShell } from '../runtime/remote-shell.js';

export interface HostCommandsConfig {
  dataDir: string;
  /** The host's address on the VM bridge with the bridge's prefix length, such as 10.31.0.1/24. */
  vmBridge: string;
  hostSshPort: number;
  sshBinary?: string;
  sshKeygenBinary?: string;
}

export interface HostCommandsStatus {
  user: string;
  address: string;
  port: number;
  ready: boolean;
  checkedAt: string | null;
  error: string | null;
}

const alias = 'clinavat-host';
const blockBegin = '# BEGIN clinavat host commands (managed by the Clinavat Hub)';
const blockEnd = '# END clinavat host commands';

function networkOf(address: string, prefix: number): string {
  const value = address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
  const network = prefix === 0 ? 0 : value - (value % 2 ** (32 - prefix));
  return `${[24, 16, 8, 0].map(shift => Math.floor(network / 2 ** shift) % 256).join('.')}/${prefix}`;
}

/**
 * Runs the administrator's local projects' shell commands on this machine, as the Hub's own user. The CLI stays in
 * the slot machine, where the project is mounted at its real path, and each command comes back here over SSH. One key,
 * kept by the Hub and authorized only from the VM network, is mounted read-only into local-project runs alone.
 */
export class HostCommands {
  /** Below the runtime key directory, which LXD already lets the Hub mount; rewritten at every start. */
  readonly directory: string;
  readonly address: string;
  readonly port: number;
  readonly user = userInfo().username;
  private readonly network: string;
  private readonly stateDirectory: string;
  private prepared?: Promise<void>;
  private state: Pick<HostCommandsStatus, 'ready' | 'checkedAt' | 'error'> = { ready: false, checkedAt: null, error: null };

  constructor(private readonly config: HostCommandsConfig, private readonly keys: KeyStore) {
    const [address, prefix] = config.vmBridge.split('/');
    this.address = address;
    this.port = config.hostSshPort;
    this.network = networkOf(address, Number(prefix));
    this.directory = join(config.dataDir, 'run', 'keys', 'host-commands');
    this.stateDirectory = join(config.dataDir, 'host-commands');
  }

  shellPath(): string { return join(this.directory, 'host-shell'); }

  status(): HostCommandsStatus { return { user: this.user, address: this.address, port: this.port, ...this.state }; }

  /** The wrapper for a run; the first run after a start, or after a failed check, logs in once to prove the path. */
  async ensureReady(): Promise<string> {
    if (!this.state.ready) await this.check();
    if (!this.state.ready) throw new Error(`本机项目的命令需要在宿主机执行，但宿主机命令入口不可用：${this.state.error}`);
    return this.shellPath();
  }

  async check(): Promise<HostCommandsStatus> {
    try {
      await this.prepare();
      await checkedCommand(this.config.sshBinary ?? 'ssh', ['-F', join(this.directory, 'config'), alias, 'true'], { timeout: 20_000 });
      this.state = { ready: true, checkedAt: new Date().toISOString(), error: null };
    } catch (error) {
      // OpenSSH frames some errors in lines of @; only the words matter here.
      const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)
        .filter(line => line.trim() && !/^@+$/.test(line.trim())).join(' ').replace(/@/g, '').replace(/\s+/g, ' ').trim();
      this.state = { ready: false, checkedAt: new Date().toISOString(),
        error: `${message}（在宿主机上以 root 运行 deploy/lxd/host-commands.sh check --hub-user ${this.user} 排查）` };
    }
    return this.status();
  }

  private prepare(): Promise<void> {
    this.prepared ??= this.write().catch((error: unknown) => {
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  private async write(): Promise<void> {
    const keygen = this.config.sshKeygenBinary ?? 'ssh-keygen';
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const identity = join(this.directory, 'id_ed25519');
    const encrypted = join(this.stateDirectory, 'id_ed25519.enc');
    const stored = await readFile(encrypted, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stored) await atomicWrite(identity, this.keys.decrypt(stored));
    else {
      await rm(identity, { force: true });
      await checkedCommand(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'clinavat-host-commands', '-f', identity]);
      await atomicWrite(encrypted, this.keys.encrypt(await readFile(identity, 'utf8')));
      await rm(`${identity}.pub`, { force: true });
    }
    await chmod(identity, 0o600);
    // `ssh-keygen -y` prints the comment only on newer OpenSSH; host-commands.sh check looks for it.
    const [type, key] = (await checkedCommand(keygen, ['-y', '-P', '', '-f', identity])).stdout.trim().split(/\s+/);
    await this.authorize(`${type} ${key} clinavat-host-commands`);
    await atomicWrite(join(this.directory, 'known_hosts'), await this.knownHosts());
    await atomicWrite(join(this.directory, 'config'), [
      `Host ${alias}`, `  HostName ${this.address}`, `  Port ${this.port}`, `  User ${this.user}`,
      `  IdentityFile "${identity}"`, '  IdentitiesOnly yes', '  BatchMode yes',
      `  UserKnownHostsFile "${join(this.directory, 'known_hosts')}"`, '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking yes', '  ConnectTimeout 10', '  ControlMaster no', '  ControlPath none',
      '  ServerAliveInterval 30', '  ServerAliveCountMax 3', '  LogLevel ERROR', '',
    ].join('\n'));
    // Named as in the slot machine, where the wrapper runs.
    await atomicWrite(this.shellPath(), renderHostShell('ssh', join(this.directory, 'config'), alias), 0o500);
  }

  /** This machine's own host keys, so no first connection has to be trusted blindly. */
  private async knownHosts(): Promise<string> {
    const pattern = this.port === 22 ? this.address : `[${this.address}]:${this.port}`;
    const files = (await readdir('/etc/ssh')).filter(name => /^ssh_host_\w+_key\.pub$/.test(name));
    const lines = (await Promise.all(files.map(name => readFile(join('/etc/ssh', name), 'utf8').catch(() => ''))))
      .map(content => content.trim().split(/\s+/)).filter(fields => fields.length >= 2).map(([type, key]) => `${pattern} ${type} ${key}`);
    if (!lines.length) throw new Error('无法读取 /etc/ssh 中的主机公钥，请确认已安装并启用 OpenSSH 服务器');
    return `${lines.join('\n')}\n`;
  }

  /** Keeps exactly one entry for the Hub's key in its own user's authorized_keys, usable only from the VM network. */
  private async authorize(publicKey: string): Promise<void> {
    const directory = join(homedir(), '.ssh');
    const file = join(directory, 'authorized_keys');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(file).catch(() => undefined))?.isSymbolicLink()) {
      throw new Error(`${file} 是符号链接，Hub 不会改写它；请改为普通文件`);
    }
    const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const kept: string[] = [];
    let inside = false;
    for (const line of existing.split('\n')) {
      if (line === blockBegin) inside = true;
      else if (inside) inside = line !== blockEnd;
      else kept.push(line);
    }
    if (inside) throw new Error(`${file} 中 Clinavat 的标记块缺少结束行，Hub 不会改写它；请手动修复`);
    const rest = kept.join('\n').replace(/\n*$/, '');
    const next = `${rest ? `${rest}\n` : ''}${blockBegin}\nfrom="${this.network}",restrict,pty ${publicKey}\n${blockEnd}\n`;
    if (next !== existing) await atomicWrite(file, next, 0o600);
  }
}
