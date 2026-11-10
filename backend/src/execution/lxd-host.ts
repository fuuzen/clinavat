import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, runCommand } from '../runtime/process.js';
import { shellQuote } from '../runtime/types.js';
import { SyncBarriers } from './barriers.js';
import {
  daemonScript, flushProgram, freezeScript, handoverScript, liveRunsScript, prepareScript, relayProgram, releasedScript, runScript,
  serviceScript, thawScript,
} from './guest-scripts.js';
import type { MachineKind, MachinePlan } from './machine-plan.js';
import type { ProcessExecutionHost } from './process-host.js';
import { delegateSuspension } from './suspension.js';
import type { ExecutionBinary, ExecutionHost, ExecutionRunOptions, ExecutionScope, ExecutionSpawnOptions } from './types.js';

export interface LxdConfig {
  dataDir: string; lxcBinary: string; lxdRemote: string; lxdProject: string; lxdImage: string;
  lxdWorkspaceImage: string; vmStartTimeoutMs: number; vmBusPorts: number; workspaceMemory: string;
}

/** What the VM host needs from the rest of the Hub to place and serve machines. */
export interface LxdServices {
  plan: MachinePlan;
  /** The project directory of a user's sync session, or undefined when the user has no such session. */
  syncProject(userId: string, syncName: string): string | undefined;
  mutagenEnvironment(userId: string): Promise<NodeJS.ProcessEnv>;
}

export interface Machine {
  name: string;
  kind: MachineKind;
  /** The slot ID or user ID the machine belongs to. */
  owner: string;
  mounts: Set<string>;
  prepared: boolean;
  queue: Promise<unknown>;
  /** A slot machine's current user, whose files are mounted; cleared by the next hand-over. */
  occupant?: string;
}
interface InstanceRow {
  name: string; status: string; type?: string; config?: Record<string, string>;
  devices?: Record<string, Record<string, string>>; expanded_config?: Record<string, string>;
  state?: { pid?: number };
}

const guestPath = '/usr/local/bin:/usr/bin:/bin';
const ownerKey = 'user.clinavat.owner';
const kindKey = 'user.clinavat.kind';
const deviceName = (path: string) => `m-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
// LXD names allow neither underscores nor arbitrary length, which slot IDs do.
export const machineName = (kind: MachineKind, owner: string) => kind === 'workspace' ? `u-${owner}`
  : `s-${createHash('sha256').update(owner).digest('hex').slice(0, 16)}`;

/**
 * Runs processes in LXD virtual machines through the Hub's restricted client. CLI processes run in the slot's own
 * machine, so an account always appears from one machine and one egress; synchronization and remote access for a
 * user run in that user's workspace machine.
 */
export class LxdExecutionHost implements ExecutionHost {
  readonly kind = 'vm' as const;
  private readonly machines = new Map<string, Machine>();
  private loaded?: Promise<void>;
  // Cold starts contend for the same storage, and a queue makes each one's timeout independent of the others.
  private startQueue: Promise<unknown> = Promise.resolve();
  private readonly uid = process.getuid!();
  private readonly gid = process.getgid!();
  private readonly barriers: SyncBarriers;

  constructor(private readonly config: LxdConfig, private readonly local: ProcessExecutionHost, private readonly services: LxdServices) {
    this.barriers = new SyncBarriers({
      relay: machine => this.service(machine, 'relay', ['python3', '-I', '-c', relayProgram, '/run/clinavat-relay/barrier.sock']),
      worker: async userId => {
        const machine = await this.attach({ userId, paths: [] });
        const env = { ...this.guestEnvironment(), ...await this.services.mutagenEnvironment(userId) };
        const started = await this.exec(machine, ['bash', '-c', daemonScript, 'clinavat-daemon', String(this.uid), String(this.gid), 'mutagen'], { env });
        if (started.code !== 0) throw new Error(`无法启动虚拟机内的同步服务：${started.stderr.trim().slice(0, 300)}`);
        return this.service(machine, 'flush', ['python3', '-I', '-c', flushProgram, 'mutagen'], env);
      },
      project: (userId, syncName) => this.services.syncProject(userId, syncName),
      prepareProject: async (userId, path) => { await this.attach({ userId, paths: [path] }); },
    });
  }

  private target(name: string): string { return `${this.config.lxdRemote}:${name}`; }

  private async lxc(args: string[], timeout = 60_000, maxBytes?: number) {
    return runCommand(this.config.lxcBinary, [...args, '--project', this.config.lxdProject], { env: childEnvironment(), timeout, maxBytes });
  }

  private async checkedLxc(args: string[], timeout?: number) {
    const result = await this.lxc(args, timeout);
    if (result.code !== 0) throw new Error(`LXD 操作失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return result;
  }

  private userDirectory(userId: string): string { return join(this.config.dataDir, 'users', userId); }

  /** Mounts survive Hub restarts, so slot occupancy starts from what LXD reports. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const result = await this.checkedLxc(['list', `${this.config.lxdRemote}:`, '--format', 'json'], 60_000);
      for (const row of JSON.parse(result.stdout) as InstanceRow[]) {
        const kind = row.config?.[kindKey] as MachineKind | undefined;
        const owner = row.config?.[ownerKey];
        if ((kind !== 'workspace' && kind !== 'slot') || !owner || row.name !== machineName(kind, owner)) continue;
        const mounts = Object.values(row.devices ?? {}).filter(device => device.type === 'disk' && device.path && device.path !== '/').map(device => device.path!);
        const users = join(this.config.dataDir, 'users') + sep;
        const occupant = kind === 'slot' ? mounts.find(path => path.startsWith(users) && path.endsWith(`${sep}engine-state`))
          ?.slice(users.length).split(sep)[0] : undefined;
        this.machines.set(row.name, { name: row.name, kind, owner, mounts: new Set(mounts), prepared: false, queue: Promise.resolve(), occupant });
      }
    })();
    return this.loaded;
  }

  private machine(kind: MachineKind, owner: string): Machine {
    const name = machineName(kind, owner);
    let machine = this.machines.get(name);
    if (!machine) {
      machine = { name, kind, owner, mounts: new Set(), prepared: false, queue: Promise.resolve() };
      this.machines.set(name, machine);
    }
    return machine;
  }

  /** Lifecycle and device changes for one machine run one at a time; LXD rejects concurrent instance updates. */
  private serialized<T>(machine: Machine, operation: () => Promise<T>): Promise<T> {
    const next = machine.queue.then(operation, operation);
    machine.queue = next.catch(() => undefined);
    return next;
  }

  private async boot(machine: Machine): Promise<void> {
    const shown = await this.checkedLxc(['list', `${this.config.lxdRemote}:`, `^${machine.name}$`, '--format', 'json']);
    const row = (JSON.parse(shown.stdout) as InstanceRow[])[0];
    if (row?.status === 'Running' && machine.prepared) return;
    const start = () => this.start(machine, row);
    const next = this.startQueue.then(start, start);
    this.startQueue = next.catch(() => undefined);
    await next;
  }

  private async start(machine: Machine, row: InstanceRow | undefined): Promise<void> {
    const { vmBusPorts, vmStartTimeoutMs } = this.config;
    const identity = this.services.plan.ensure(machine.kind, machine.owner, machine.name);
    const container = machine.kind === 'workspace';
    if (row && (row.type === 'container') !== container) {
      throw new Error(`实例 ${machine.name} 的类型与当前版本不符（工作区应为容器、槽位应为虚拟机），请删除后由 Hub 重新创建`);
    }
    if (!row) {
      const idmap = this.uid === this.gid ? `both ${this.uid} ${this.uid}` : `uid ${this.uid} ${this.uid}\ngid ${this.gid} ${this.gid}`;
      await this.checkedLxc(['init', ...(container
        // Its profile isolates root and the remaining uid range. Only the Hub's uid/gid are mapped directly for
        // ordinary bind mounts: LXD forbids shift=true when a project restricts source paths.
        // The default profile carries VM-only settings.
        ? [this.target(this.config.lxdWorkspaceImage), this.target(machine.name), '--profile', 'workspace',
          '-c', `limits.memory=${this.config.workspaceMemory}`]
        // Agents run arbitrary code: a slot gets its own kernel.
        : [this.target(this.config.lxdImage), this.target(machine.name), '--vm', '-c', `limits.max_bus_ports=${vmBusPorts}`]),
        '-c', `raw.idmap=${idmap}`, '-c', `${kindKey}=${machine.kind}`, '-c', `${ownerKey}=${machine.owner}`], vmStartTimeoutMs).catch((error: Error) => {
        throw /limit|exceed/i.test(error.message)
          ? new Error(`${error.message}（LXD 项目配额不足，请调高 limits.memory、limits.cpu、limits.virtual-machines 或 limits.containers）`) : error;
      });
    }
    if (row && (row.config?.[kindKey] !== machine.kind || row.config?.[ownerKey] !== machine.owner)) {
      await this.checkedLxc(['config', 'set', this.target(machine.name), `${kindKey}=${machine.kind}`, `${ownerKey}=${machine.owner}`]);
    }
    if (row?.status !== 'Running') {
      // Bus ports and addresses can only change while stopped; older instances catch up on their next start.
      if (row && !container && Number(row.expanded_config?.['limits.max_bus_ports'] ?? 0) < vmBusPorts) {
        await this.checkedLxc(['config', 'set', this.target(machine.name), `limits.max_bus_ports=${vmBusPorts}`]);
      }
      // The gateway chooses the egress by this address.
      if (row?.devices?.eth0?.['ipv4.address'] !== identity.address) {
        await this.checkedLxc(row?.devices?.eth0
          ? ['config', 'device', 'set', this.target(machine.name), 'eth0', `ipv4.address=${identity.address}`]
          : ['config', 'device', 'override', this.target(machine.name), 'eth0', `ipv4.address=${identity.address}`]);
      }
      await this.rebindRuntimeMounts(machine, row?.devices, false);
      await this.checkedLxc(['start', this.target(machine.name)], vmStartTimeoutMs);
      machine.prepared = false;
    } else if (row.devices?.eth0?.['ipv4.address'] !== identity.address) {
      throw new Error(`实例 ${machine.name} 未使用分配的固定地址 ${identity.address}，请停止该实例后重试`);
    }
    if (machine.prepared) return;
    const deadline = Date.now() + vmStartTimeoutMs;
    while ((await this.exec(machine, ['true'], { timeout: 15_000 })).code !== 0) {
      if (Date.now() > deadline) throw new Error(`${container ? '工作区容器' : '虚拟机'}启动超时（${Math.round(vmStartTimeoutMs / 1000)} 秒），可调高 CLINAVAT_VM_START_TIMEOUT_MS`);
      await delay(1000);
    }
    const prepared = await this.exec(machine, ['bash', '-c', prepareScript, 'clinavat-prepare', String(this.uid), String(this.gid),
      this.controlDirectory(), identity.hostname ?? '', identity.machineId ?? '']);
    if (prepared.code !== 0) throw new Error(`虚拟机初始化失败：${prepared.stderr.trim().slice(0, 500)}`);
    if (row?.status === 'Running') await this.rebindRuntimeMounts(machine, row.devices, true);
    machine.prepared = true;
  }

  private async rebindRuntimeMounts(machine: Machine, devices: InstanceRow['devices'], running: boolean): Promise<void> {
    const runtime = resolve(this.config.dataDir, 'run') + sep;
    for (const [name, device] of Object.entries(devices ?? {})) {
      if (device.type !== 'disk' || !device.path || !resolve(device.path).startsWith(runtime)) continue;
      // systemd recreates the runtime tree when the Hub stops; surviving guests still hold its old directory inodes.
      await mkdir(device.path, { recursive: true, mode: 0o700 });
      const source = await realpath(device.path);
      if (!running) {
        await this.checkedLxc(['config', 'device', 'set', this.target(machine.name), name, `source=${source}`]);
        continue;
      }
      await this.checkedLxc(['config', 'device', 'remove', this.target(machine.name), name]);
      machine.mounts.delete(device.path);
      const options = Object.entries({ ...device, source }).filter(([key]) => key !== 'type').map(([key, value]) => `${key}=${value}`);
      await this.checkedLxc(['config', 'device', 'add', this.target(machine.name), name, 'disk', ...options]);
      machine.mounts.add(device.path);
    }
  }

  private controlDirectory(): string { return join(this.config.dataDir, 'run', 'cm'); }

  private exec(machine: Machine, command: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBytes?: number; input?: string } = {}) {
    return runCommand(this.config.lxcBinary, this.execArguments(machine, command, options.env), {
      env: childEnvironment(), timeout: options.timeout ?? 60_000, maxBytes: options.maxBytes, input: options.input,
    });
  }

  private execArguments(machine: Machine, command: string[], env: NodeJS.ProcessEnv = {}): string[] {
    const variables = Object.entries(env).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    return ['exec', this.target(machine.name), '--project', this.config.lxdProject, '--mode', 'non-interactive', ...variables, '--', ...command];
  }

  /** A long-lived helper as the unprivileged user; its stdio is the Hub's channel to it. */
  private service(machine: Machine, name: string, command: string[], env: NodeJS.ProcessEnv = this.guestEnvironment()): ChildProcessWithoutNullStreams {
    return spawn(this.config.lxcBinary, this.execArguments(machine,
      ['bash', '-c', serviceScript, 'clinavat-service', name, String(this.uid), String(this.gid), ...command], env), {
      env: childEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  }

  private slotHome(slotId: string): string { return join(this.config.dataDir, 'slots', slotId); }

  /** Ends the previous user's presence in a slot machine before another user's files are mounted. */
  private async handOver(machine: Machine): Promise<void> {
    const live = await this.exec(machine, ['bash', '-c', liveRunsScript, 'clinavat-live']);
    if (live.code !== 0 || live.stdout.trim()) throw new Error('槽位虚拟机中上一位用户的进程尚未结束，已暂停交接');
    this.barriers.close(machine);
    const cleaned = await this.exec(machine, ['bash', '-c', handoverScript, 'clinavat-handover', String(this.uid), this.controlDirectory()]);
    if (cleaned.code !== 0) throw new Error(`无法清理槽位虚拟机：${cleaned.stderr.trim().slice(0, 300)}`);
    // Only the slot's own directories stay: its home and its usage probe directory.
    const kept = [this.slotHome(machine.owner), join(this.config.dataDir, 'run', 'usage-probes', machine.owner)];
    for (const path of [...machine.mounts]) {
      if (kept.includes(path)) continue;
      await this.checkedLxc(['config', 'device', 'remove', this.target(machine.name), deviceName(path)]);
      machine.mounts.delete(path);
    }
    machine.occupant = undefined;
  }

  private async attach(scope: ExecutionScope): Promise<Machine> {
    if (!scope.slotId && !scope.userId) throw new Error('执行范围缺少用户或槽位');
    await this.load();
    const machine = scope.slotId ? this.machine('slot', scope.slotId) : this.machine('workspace', scope.userId);
    const user = scope.userId ? this.userDirectory(scope.userId) : undefined;
    const keys = scope.userId ? join(this.config.dataDir, 'run', 'keys', scope.userId) : undefined;
    for (const path of scope.paths) {
      // A slot's home belongs only to its own machine.
      if (resolve(path).startsWith(join(resolve(this.config.dataDir), 'slots') + sep)
        && (!scope.slotId || !resolve(path).startsWith(this.slotHome(scope.slotId)))) throw new Error('槽位目录只能在该槽位的虚拟机中使用');
    }
    const writable = machine.kind === 'slot'
      ? [...(user ? [join(user, 'engine-state')] : []), ...scope.paths]
      : [join(user!, 'mutagen'), ...scope.paths];
    const readOnly = [...(user ? [join(user, '.ssh'), keys!] : []), ...(machine.kind === 'workspace' ? [join(user!, 'mutagen-ssh')] : []),
      ...(scope.readOnlyPaths ?? [])];
    return this.serialized(machine, async () => {
      await this.boot(machine);
      if (machine.kind === 'slot' && scope.userId && machine.occupant && machine.occupant !== scope.userId) await this.handOver(machine);
      for (const [paths, readonly] of [[[...new Set(writable)], false], [[...new Set(readOnly)], true]] as const) {
        for (const path of paths) {
          if (machine.mounts.has(path)) continue;
          await mkdir(path, { recursive: true, mode: 0o700 });
          // LXD refuses a source reached through a symlink, such as the data directory's run link.
          await this.checkedLxc(['config', 'device', 'add', this.target(machine.name), deviceName(path), 'disk',
            `source=${await realpath(path)}`, `path=${path}`, ...(readonly ? ['readonly=true'] : [])]).catch((error: Error) => {
            if (/not allowed|restricted/i.test(error.message)) throw new Error(`${error.message}（目录不在 LXD 项目的挂载白名单中，本机项目目录请用 egress-bindings.sh prepare-containers --local-root 加入）`);
            throw /\bport|pci/i.test(error.message)
              ? new Error(`${error.message}（虚拟机设备端口可能已用尽：每个挂载目录各占一个。调高 limits.max_bus_ports 后需重启该虚拟机）`) : error;
          });
          machine.mounts.add(path);
        }
      }
      if (machine.kind === 'slot' && scope.userId) {
        machine.occupant = scope.userId;
        this.barriers.ensure(machine, scope.userId);
      }
      return machine;
    });
  }

  private guestEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: guestPath, LANG: 'C.UTF-8', HOME: '/home/clinavat', USER: 'clinavat', LOGNAME: 'clinavat', SHELL: '/bin/bash',
      // Guests boot in UTC; the CLI must see the same time zone wherever it runs for an account.
      TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  baseEnvironment(_scope: ExecutionScope): NodeJS.ProcessEnv { return this.guestEnvironment(); }

  async binary(_scope: ExecutionScope, name: ExecutionBinary): Promise<string> { return name; }

  private command(id: string, cwd: string, binary: string, args: string[]): string[] {
    return ['bash', '-c', runScript, 'clinavat-run', id, String(this.uid), String(this.gid), cwd, binary, ...args];
  }

  // Probes carry no user; a hand-over waits only for user runs.
  private runId(scope: ExecutionScope): string { return `${scope.userId ? 'run' : 'probe'}-${randomBytes(12).toString('hex')}`; }

  async spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
    const machine = await this.attach(options.scope);
    const id = this.runId(options.scope);
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
    const machine = await this.attach(options.scope);
    const env = { ...this.guestEnvironment(), ...options.env };
    if (binary === 'mutagen') {
      if (machine.kind !== 'workspace') throw new Error('同步只能在用户的工作区虚拟机中运行');
      // Autostarted from a run's cgroup, the daemon would be killed when that run ends.
      const started = await this.exec(machine, ['bash', '-c', daemonScript, 'clinavat-daemon', String(this.uid), String(this.gid), binary], { env });
      if (started.code !== 0) throw new Error(`无法启动虚拟机内的同步服务：${started.stderr.trim().slice(0, 300)}`);
    }
    return this.exec(machine, this.command(this.runId(options.scope), options.cwd ?? '/', binary, args),
      { env, timeout: options.timeout ?? 30_000, maxBytes: options.maxBytes, input: options.input });
  }

  async loginCommand(slotId: string, home: string, argv: string[], env: Record<string, string>): Promise<string> {
    const machine = await this.attach({ userId: '', slotId, paths: [home] });
    const variables = { ...this.guestEnvironment(), ...env };
    return [this.config.lxcBinary, 'exec', this.target(machine.name), '--project', this.config.lxdProject, '-t', '--cwd', home,
      ...Object.entries(variables).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--', 'setpriv', `--reuid=${this.uid}`, `--regid=${this.gid}`, '--clear-groups', '--', ...argv].map(shellQuote).join(' ');
  }

  async assertReleased(home: string, sessionId?: string): Promise<void> {
    await this.load();
    const shown = await this.checkedLxc(['list', `${this.config.lxdRemote}:`, '--format', 'json']);
    const workspaceCgroups = new Set<string>();
    for (const row of JSON.parse(shown.stdout) as InstanceRow[]) {
      if (row.type !== 'container' || row.status !== 'Running' || this.machines.get(row.name)?.kind !== 'workspace') continue;
      const pid = row.state?.pid;
      if (!pid || !Number.isSafeInteger(pid) || pid <= 0) continue;
      const project = this.config.lxdProject === 'default' ? '' : `${this.config.lxdProject}_`;
      const root = `/lxc.payload.${project}${row.name}`;
      const cgroups = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (['ENOENT', 'ESRCH'].includes(error.code ?? '')) return '';
        throw error;
      });
      const unified = cgroups.split('\n').find(line => line.startsWith('0::'))?.slice(3);
      // LXD may be remote or its PID may have exited; only the matching kernel cgroup proves local ownership.
      if (unified === root || unified?.startsWith(`${root}/`)) workspaceCgroups.add(root);
    }
    await this.local.assertReleased(home, sessionId, workspaceCgroups);
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

  /**
   * Unmounts paths that move or change owner. A slot home stays in its own machine: the previous user's files
   * leave it when the next user takes the slot.
   */
  async revoke(userId: string, paths: string[]): Promise<void> {
    await this.load();
    for (const machine of this.machines.values()) {
      if (machine.kind === 'workspace' ? machine.owner !== userId : machine.occupant !== userId) continue;
      await this.serialized(machine, async () => {
        for (const path of paths) {
          if (!machine.mounts.has(path) || (machine.kind === 'slot' && path === this.slotHome(machine.owner))) continue;
          await this.checkedLxc(['config', 'device', 'remove', this.target(machine.name), deviceName(path)]);
          machine.mounts.delete(path);
        }
      });
    }
  }

  async health() {
    const image = async (alias: string) => (await this.lxc(['image', 'info', this.target(alias)], 15_000).catch(() => undefined))?.code === 0;
    const [agent, workspace] = await Promise.all([image(this.config.lxdImage), image(this.config.lxdWorkspaceImage)]);
    return { kind: this.kind, claude: agent, codex: agent, mutagen: workspace, ssh: agent && workspace };
  }
}
