import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, runCommand } from '../runtime/process.js';
import { daemonScript, freezeScript, prepareScript, releasedScript, runScript, thawScript } from './guest-scripts.js';
import type { ProcessExecutionHost } from './process-host.js';
import { delegateSuspension } from './suspension.js';
import type { ExecutionBinary, ExecutionHost, ExecutionRunOptions, ExecutionScope, ExecutionSpawnOptions } from './types.js';

export interface LxdConfig { dataDir: string; lxcBinary: string; lxdRemote: string; lxdProject: string; lxdImage: string }

interface Machine { name: string; mounts: Set<string>; prepared: boolean; queue: Promise<unknown> }
interface InstanceRow { name: string; status: string; devices?: Record<string, Record<string, string>> }

const guestPath = '/usr/local/bin:/usr/bin:/bin';
// Concurrent first-time image initialization shares host storage and can take several minutes.
const startDeadline = 600_000;
const machineName = (userId: string) => `u-${userId}`;
const deviceName = (path: string) => `m-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;

/** Runs each user's processes in that user's own LXD virtual machine, through the Hub's restricted client. */
export class LxdExecutionHost implements ExecutionHost {
  readonly kind = 'vm' as const;
  private readonly machines = new Map<string, Machine>();
  private loaded?: Promise<void>;
  private readonly uid = process.getuid!();
  private readonly gid = process.getgid!();

  constructor(private readonly config: LxdConfig, private readonly local: ProcessExecutionHost) {}

  private target(name: string): string { return `${this.config.lxdRemote}:${name}`; }

  private async lxc(args: string[], timeout = 60_000, maxBytes?: number) {
    return runCommand(this.config.lxcBinary, [...args, '--project', this.config.lxdProject], { env: childEnvironment(), timeout, maxBytes });
  }

  private async checkedLxc(args: string[], timeout?: number) {
    const result = await this.lxc(args, timeout);
    if (result.code !== 0) throw new Error(`LXD 操作失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return result;
  }

  /** Mounts survive Hub restarts, so slot exclusivity starts from what LXD reports. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const result = await this.checkedLxc(['list', `${this.config.lxdRemote}:`, '--format', 'json'], 60_000);
      for (const row of JSON.parse(result.stdout) as InstanceRow[]) {
        if (!row.name.startsWith('u-')) continue;
        const mounts = Object.values(row.devices ?? {}).filter(device => device.type === 'disk' && device.path && device.path !== '/').map(device => device.path);
        this.machines.set(row.name.slice(2), { name: row.name, mounts: new Set(mounts), prepared: false, queue: Promise.resolve() });
      }
    })();
    return this.loaded;
  }

  private machine(userId: string): Machine {
    let machine = this.machines.get(userId);
    if (!machine) {
      machine = { name: machineName(userId), mounts: new Set(), prepared: false, queue: Promise.resolve() };
      this.machines.set(userId, machine);
    }
    return machine;
  }

  /** Lifecycle and device changes for one user run one at a time; LXD rejects concurrent instance updates. */
  private serialized<T>(machine: Machine, operation: () => Promise<T>): Promise<T> {
    const next = machine.queue.then(operation, operation);
    machine.queue = next.catch(() => undefined);
    return next;
  }

  private async boot(machine: Machine): Promise<void> {
    const shown = await this.lxc(['list', `${this.config.lxdRemote}:`, `^${machine.name}$`, '--format', 'json']);
    const row = shown.code === 0 ? (JSON.parse(shown.stdout) as InstanceRow[])[0] : undefined;
    if (!row) {
      const idmap = this.uid === this.gid ? `both ${this.uid} ${this.uid}` : `uid ${this.uid} ${this.uid}\ngid ${this.gid} ${this.gid}`;
      await this.checkedLxc(['init', this.target(this.config.lxdImage), this.target(machine.name), '--vm', '-c', `raw.idmap=${idmap}`], startDeadline);
    }
    if (row?.status !== 'Running') {
      await this.checkedLxc(['start', this.target(machine.name)], startDeadline);
      machine.prepared = false;
    }
    if (machine.prepared) return;
    const deadline = Date.now() + startDeadline;
    while ((await this.exec(machine, ['true'], { timeout: 15_000 })).code !== 0) {
      if (Date.now() > deadline) throw new Error('用户虚拟机启动超时');
      await delay(1000);
    }
    const prepared = await this.exec(machine, ['bash', '-c', prepareScript, 'clinavat-prepare', String(this.uid), String(this.gid), join(this.config.dataDir, 'run', 'cm')]);
    if (prepared.code !== 0) throw new Error(`用户虚拟机初始化失败：${prepared.stderr.trim().slice(0, 500)}`);
    machine.prepared = true;
  }

  private exec(machine: Machine, command: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBytes?: number; input?: string } = {}) {
    return runCommand(this.config.lxcBinary, this.execArguments(machine, command, options.env), {
      env: childEnvironment(), timeout: options.timeout ?? 60_000, maxBytes: options.maxBytes, input: options.input,
    });
  }

  private execArguments(machine: Machine, command: string[], env: NodeJS.ProcessEnv = {}): string[] {
    const variables = Object.entries(env).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    return ['exec', this.target(machine.name), '--project', this.config.lxdProject, '--mode', 'non-interactive', ...variables, '--', ...command];
  }

  private slotHome(path: string): boolean {
    return resolve(path).startsWith(join(resolve(this.config.dataDir), 'slots') + sep);
  }

  private async attach(scope: ExecutionScope): Promise<Machine> {
    await this.load();
    const machine = this.machine(scope.userId);
    const user = join(this.config.dataDir, 'users', scope.userId);
    const writable = [...new Set([join(user, 'engine-state'), join(user, 'mutagen'), ...scope.paths])];
    const readOnly = [...new Set([join(user, '.ssh'), join(user, 'mutagen-ssh'), join(this.config.dataDir, 'run', 'keys', scope.userId), ...(scope.readOnlyPaths ?? [])])];
    return this.serialized(machine, async () => {
      await this.boot(machine);
      for (const [paths, readonly] of [[writable, false], [readOnly, true]] as const) {
        for (const path of paths) {
          if (machine.mounts.has(path)) continue;
          // A slot handed to this user must already have been revoked from the previous one.
          if (this.slotHome(path) && [...this.machines.values()].some(other => other !== machine && other.mounts.has(path))) {
            throw new Error('槽位目录仍挂载在其他用户的虚拟机中，已拒绝交接');
          }
          await mkdir(path, { recursive: true, mode: 0o700 });
          // LXD refuses a source reached through a symlink, such as the data directory's run link.
          await this.checkedLxc(['config', 'device', 'add', this.target(machine.name), deviceName(path), 'disk',
            `source=${await realpath(path)}`, `path=${path}`, ...(readonly ? ['readonly=true'] : [])]);
          machine.mounts.add(path);
        }
      }
      return machine;
    });
  }

  private guestEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: guestPath, LANG: 'C.UTF-8', HOME: '/home/clinavat', USER: 'clinavat', LOGNAME: 'clinavat', SHELL: '/bin/bash',
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    };
  }

  baseEnvironment(scope: ExecutionScope): NodeJS.ProcessEnv {
    return scope.trusted ? this.local.baseEnvironment() : this.guestEnvironment();
  }

  async binary(scope: ExecutionScope, name: ExecutionBinary): Promise<string> {
    return scope.trusted ? this.local.binary(scope, name) : name;
  }

  private command(id: string, cwd: string, binary: string, args: string[]): string[] {
    return ['bash', '-c', runScript, 'clinavat-run', id, String(this.uid), String(this.gid), cwd, binary, ...args];
  }

  async spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
    if (options.scope.trusted) return this.local.spawn(binary, args, options);
    const machine = await this.attach(options.scope);
    const id = `run-${randomBytes(12).toString('hex')}`;
    const child = spawn(this.config.lxcBinary, this.execArguments(machine, this.command(id, options.cwd, binary, args), options.env), {
      env: childEnvironment(), detached: true, stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    delegateSuspension(child, {
      freeze: async () => {
        const result = await this.exec(machine, ['bash', '-c', freezeScript, 'clinavat-freeze', id]);
        if (result.code !== 0) throw new Error(`无法暂停虚拟机内的进程：${result.stderr.trim().slice(0, 300)}`);
        return result.stdout.trim() !== 'BUSY';
      },
      thaw: async () => {
        const result = await this.exec(machine, ['bash', '-c', thawScript, 'clinavat-thaw', id]);
        if (result.code !== 0) throw new Error(`无法恢复虚拟机内的进程：${result.stderr.trim().slice(0, 300)}`);
      },
    });
    return child;
  }

  async run(binary: string, args: string[], options: ExecutionRunOptions) {
    if (options.scope.trusted) return this.local.run(binary, args, options);
    const machine = await this.attach(options.scope);
    const env = { ...this.guestEnvironment(), ...options.env };
    if (binary === 'mutagen') {
      // Autostarted from a run's cgroup, the daemon would be killed when that run ends.
      const started = await this.exec(machine, ['bash', '-c', daemonScript, 'clinavat-daemon', String(this.uid), String(this.gid), binary], { env });
      if (started.code !== 0) throw new Error(`无法启动虚拟机内的同步服务：${started.stderr.trim().slice(0, 300)}`);
    }
    const id = `run-${randomBytes(12).toString('hex')}`;
    return this.exec(machine, this.command(id, options.cwd ?? '/', binary, args), { env, timeout: options.timeout ?? 30_000, maxBytes: options.maxBytes, input: options.input });
  }

  async assertReleased(home: string, sessionId?: string): Promise<void> {
    await this.local.assertReleased(home, sessionId);
    await this.load();
    const holders = [...this.machines.values()].filter(machine => machine.mounts.has(home));
    for (const machine of holders) {
      const result = await this.exec(machine, ['bash', '-c', releasedScript, 'clinavat-released', home, sessionId ?? '']);
      if (result.code !== 0) {
        // A stopped guest has no processes; anything else cannot be proven safe for a hand-off.
        if (/not running/i.test(result.stderr)) continue;
        throw new Error(`无法确认虚拟机是否已释放槽位：${result.stderr.trim().slice(0, 300)}`);
      }
      const survivors = result.stdout.trim().split('\n').filter(Boolean);
      if (survivors.length) throw new Error(`槽位仍被虚拟机内的进程 ${survivors.join(', ')} 使用，已保留用户数据并暂停交接`);
    }
  }

  async revoke(userId: string, paths: string[]): Promise<void> {
    await this.load();
    const machine = this.machines.get(userId);
    if (!machine) return;
    await this.serialized(machine, async () => {
      for (const path of paths) {
        if (!machine.mounts.has(path)) continue;
        await this.checkedLxc(['config', 'device', 'remove', this.target(machine.name), deviceName(path)]);
        machine.mounts.delete(path);
      }
    });
  }

  async health() {
    const result = await this.lxc(['image', 'info', this.target(this.config.lxdImage)], 15_000).catch(() => undefined);
    const available = result?.code === 0;
    return { kind: this.kind, claude: available, codex: available, mutagen: available, ssh: available };
  }
}
