import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, runCommand } from '../runtime/process.js';
import { SyncBarriers } from './barriers.js';
import {
  daemonScript, flushProgram, freezeScript, handoverScript, liveRunsScript, prepareScript, relayProgram, releasedScript, runScript,
  serviceScript, thawScript,
} from './guest-scripts.js';
import {
  assertGuestsReleased, attachMounts, formatLoginCommand, machineName, parseLoadedMounts, parseManagedInstances,
  prepareStoppedInstance, rebindRuntimeMounts, removeNonSlotMounts, revokeMachineMounts,
  type InstanceRow, type LxdMountRunner, type Machine,
} from './lxd-mounts.js';
export { machineName, type Machine } from './lxd-mounts.js';
import type { MachineKind, MachinePlan } from './machine-plan.js';
import type { ProcessExecutionHost } from './process-host.js';
import {
  describeResources, parseProjectQuota, planResources, quotaError, type MachineResourceHost, type MachineResources,
} from './machine-resources.js';
import { delegateSuspension } from './suspension.js';
import { defaultTimezone, guestEnvironment, saveSlotTimezone, timezoneScript, missingTimezoneData } from './timezones.js';
import { workspaceCgroups } from './machine-processes.js';
import type { ExecutionBinary, ExecutionHost, ExecutionRunOptions, ExecutionScope, ExecutionSpawnOptions } from './types.js';
import type { SkippedLinks } from '../runtime/sync-status.js';
import type { ClientExecBarrierReply, ClientExecBarrierRequest } from '../client-host/exec-barrier.js';

export interface LxdConfig {
  dataDir: string; workspaceDir?: string; lxcBinary: string; lxdRemote: string; lxdProject: string; lxdImage: string;
  lxdWorkspaceImage: string; vmStartTimeoutMs: number; vmBusPorts: number;
}

/** What the VM host needs from the rest of the Hub to place and serve machines. */
export interface LxdServices {
  plan: MachinePlan;
  syncProject(userId: string, syncName: string): string | undefined;
  mutagenEnvironment(userId: string): Promise<NodeJS.ProcessEnv>;
  reportSkippedLinks(userId: string, syncName: string, skipped: SkippedLinks): string | undefined;
  clientExec?(userId: string, request: ClientExecBarrierRequest): Promise<ClientExecBarrierReply>;
  resources(kind: MachineKind): MachineResources;
  onBeforeMachineRevoke?: (address: string, reason: string) => Promise<void>;
}

/**
 * Runs processes in LXD virtual machines through the Hub's restricted client. CLI processes run in the slot's own
 * machine, so an account always appears from one machine and one egress; synchronization and remote access for a
 * user run in that user's workspace machine.
 */
export class LxdExecutionHost implements ExecutionHost, MachineResourceHost {
  readonly kind = 'vm' as const;
  private readonly machines = new Map<string, Machine>();
  private loaded?: Promise<void>;
  // Cold starts contend for the same storage, and a queue makes each one's timeout independent of the others.
  private startQueue: Promise<unknown> = Promise.resolve();
  private readonly uid = process.getuid!();
  private readonly gid = process.getgid!();
  private readonly barriers: SyncBarriers;
  private readonly mountRunner: LxdMountRunner;
  private readonly resourceErrors = new Map<string, string>();
  onBeforeMachineRevoke?: (address: string, reason: string) => Promise<void>;

  constructor(private readonly config: LxdConfig, private readonly local: ProcessExecutionHost, private readonly services: LxdServices) {
    this.mountRunner = { target: name => this.target(name), checkedLxc: (args, timeout) => this.checkedLxc(args, timeout) };
    this.barriers = new SyncBarriers({
      relay: machine => this.service(machine, 'relay', ['python3', '-I', '-c', relayProgram, '/run/clinavat-relay/barrier.sock']),
      worker: async userId => {
        const machine = await this.attach({ userId, paths: [] });
        const env = { ...guestEnvironment(this.services.plan), ...await this.services.mutagenEnvironment(userId) };
        const started = await this.exec(machine, ['bash', '-c', daemonScript, 'clinavat-daemon', String(this.uid), String(this.gid), 'mutagen'], { env });
        if (started.code !== 0) throw new Error(`无法启动虚拟机内的同步服务：${started.stderr.trim().slice(0, 300)}`);
        return this.service(machine, 'flush', ['python3', '-I', '-c', flushProgram, 'mutagen'], env);
      },
      project: (userId, syncName) => this.services.syncProject(userId, syncName),
      prepareProject: async (userId, path) => { await this.attach({ userId, paths: [path] }); },
      skippedLinks: (userId, syncName, skipped) => this.services.reportSkippedLinks(userId, syncName, skipped),
      clientExec: this.services.clientExec ? (userId, req) => this.services.clientExec!(userId, req) : undefined,
    });
  }

  private target(name: string): string { return `${this.config.lxdRemote}:${name}`; }
  private controlDirectory(): string { return join(this.config.dataDir, 'run', 'cm'); }
  private lxc(args: string[], timeout = 60_000, maxBytes?: number) {
    return runCommand(this.config.lxcBinary, [...args, '--project', this.config.lxdProject], { env: childEnvironment(), timeout, maxBytes });
  }
  private async checkedLxc(args: string[], timeout?: number) {
    const result = await this.lxc(args, timeout);
    if (result.code !== 0) throw new Error(`LXD 操作失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return result;
  }

  /** Mounts survive Hub restarts, so slot occupancy starts from what LXD reports. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const row of await this.managedInstances()) {
        const { mounts, occupant } = parseLoadedMounts(this.config.dataDir, row.kind, row.devices);
        this.machines.set(row.name, { name: row.name, kind: row.kind, owner: row.owner, mounts, prepared: false, queue: Promise.resolve(), occupant });
      }
    })();
    return this.loaded;
  }

  private machine(kind: MachineKind, owner: string): Machine {
    const name = machineName(kind, owner);
    const existing = this.machines.get(name);
    if (existing) return existing;
    const created: Machine = { name, kind, owner, mounts: new Map(), prepared: false, queue: Promise.resolve() };
    this.machines.set(name, created);
    return created;
  }

  /** Lifecycle and device changes for one machine run one at a time; LXD rejects concurrent instance updates. */
  private serialized<T>(machine: Machine, operation: () => Promise<T>): Promise<T> {
    const next = machine.queue.then(operation, operation);
    machine.queue = next.catch(() => undefined);
    return next;
  }

  private async managedInstances() { return parseManagedInstances((await this.checkedLxc(['list', `${this.config.lxdRemote}:`, '--format', 'json'], 60_000)).stdout); }
  private async instance(name: string): Promise<InstanceRow | undefined> {
    return (JSON.parse((await this.checkedLxc(['list', `${this.config.lxdRemote}:`, `^${name}$`, '--format', 'json'])).stdout) as InstanceRow[])[0];
  }

  private async fitResources(row: InstanceRow, kind: MachineKind): Promise<void> {
    for (const command of planResources(this.target(row.name), row, this.services.resources(kind)).commands) {
      await this.checkedLxc(command).catch((error: Error) => { throw quotaError(error); });
    }
    this.resourceErrors.delete(row.name);
  }

  private async boot(machine: Machine): Promise<void> {
    const row = await this.instance(machine.name);
    if (row?.status === 'Running' && machine.prepared) return;
    const next = this.startQueue.then(() => this.start(machine, row), () => this.start(machine, row));
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
    if (row?.status !== 'Running') {
      await prepareStoppedInstance({
        runner: this.mountRunner, dataDir: this.config.dataDir, machine, row, identity, container,
        image: container ? this.config.lxdWorkspaceImage : this.config.lxdImage, vmBusPorts, vmStartTimeoutMs,
        resources: this.services.resources(machine.kind), uid: this.uid, gid: this.gid,
        fitResources: (current, kind) => this.fitResources(current, kind),
        onResourceError: message => { this.resourceErrors.set(machine.name, message); },
        quotaError,
      });
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
    if (!container) await this.applyTimezone(machine, identity.timezone);
    if (row?.status === 'Running') await rebindRuntimeMounts(this.mountRunner, this.config.dataDir, machine, row.devices, true);
    machine.prepared = true;
  }

  private exec(machine: Machine, command: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBytes?: number; input?: string } = {}) {
    return runCommand(this.config.lxcBinary, this.execArguments(machine, command, options.env),
      { env: childEnvironment(), timeout: options.timeout ?? 60_000, maxBytes: options.maxBytes, input: options.input });
  }
  private execArguments(machine: Machine, command: string[], env: NodeJS.ProcessEnv = {}): string[] {
    const environment = machine.kind === 'slot' ? { ...env, TZ: this.services.plan.get('slot', machine.owner)?.timezone ?? defaultTimezone() } : env;
    const variables = Object.entries(environment).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    return ['exec', this.target(machine.name), '--project', this.config.lxdProject, '--mode', 'non-interactive', ...variables, '--', ...command];
  }
  private service(machine: Machine, name: string, command: string[], env: NodeJS.ProcessEnv = guestEnvironment(this.services.plan)): ChildProcessWithoutNullStreams {
    return spawn(this.config.lxcBinary, this.execArguments(machine, ['bash', '-c', serviceScript, 'clinavat-service', name, String(this.uid), String(this.gid), ...command], env),
      { env: childEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  }
  private async revokeMachine(kind: MachineKind, owner: string, reason: string): Promise<void> {
    const address = this.services.plan.get(kind, owner)?.address;
    if (address) await (this.onBeforeMachineRevoke ?? this.services.onBeforeMachineRevoke)?.(address, reason);
  }

  /** Ends the previous user's presence in a slot machine before another user's files are mounted. */
  private async handOver(machine: Machine): Promise<void> {
    const live = await this.exec(machine, ['bash', '-c', liveRunsScript, 'clinavat-live']);
    if (live.code !== 0 || live.stdout.trim()) throw new Error('槽位虚拟机中上一位用户的进程尚未结束，已暂停交接');
    await this.revokeMachine(machine.kind, machine.owner, 'handover');
    this.barriers.close(machine);
    const cleaned = await this.exec(machine, ['bash', '-c', handoverScript, 'clinavat-handover', String(this.uid), this.controlDirectory()]);
    if (cleaned.code !== 0) throw new Error(`无法清理槽位虚拟机：${cleaned.stderr.trim().slice(0, 300)}`);
    await removeNonSlotMounts(this.mountRunner, this.config.dataDir, machine);
    machine.occupant = undefined;
  }

  private async attach(scope: ExecutionScope): Promise<Machine> {
    if (!scope.slotId && !scope.userId) throw new Error('执行范围缺少用户或槽位');
    await this.load();
    const machine = scope.slotId ? this.machine('slot', scope.slotId) : this.machine('workspace', scope.userId);
    return this.serialized(machine, async () => {
      await this.boot(machine);
      if (machine.kind === 'slot' && scope.userId && machine.occupant && machine.occupant !== scope.userId) await this.handOver(machine);
      await attachMounts(this.mountRunner, { dataDir: this.config.dataDir, workspaceDir: this.config.workspaceDir }, machine, scope);
      if (machine.kind === 'slot' && scope.userId) { machine.occupant = scope.userId; this.barriers.ensure(machine, scope.userId); }
      return machine;
    });
  }

  baseEnvironment(scope: ExecutionScope): NodeJS.ProcessEnv { return guestEnvironment(this.services.plan, scope); }

  private async applyTimezone(machine: Machine, timezone: string | null, initializing = true): Promise<void> {
    const result = await this.exec(machine, ['bash', '-c', timezoneScript, 'clinavat-timezone', timezone ?? defaultTimezone()]);
    if (initializing && timezone === null && result.code === missingTimezoneData) return;
    if (result.code !== 0) throw new Error(`槽位虚拟机时区设置失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }

  async setSlotTimezone(slotId: string, timezone: string | null): Promise<{ applied: boolean }> {
    await this.load();
    const machine = this.machine('slot', slotId);
    return this.serialized(machine, () => saveSlotTimezone(this.services.plan, slotId, machine.name, timezone, async value => {
      const row = await this.instance(machine.name);
      if (!row || row.status === 'Stopped') { machine.prepared = false; return false; }
      if (row.status !== 'Running') throw new Error(`槽位虚拟机当前状态为 ${row.status}，请等待运行或停止后重试`);
      await this.applyTimezone(machine, value, false);
      return true;
    }));
  }

  async ensureWorkspace(userId: string): Promise<void> { await this.attach({ userId, paths: [] }); }
  async binary(_scope: ExecutionScope, name: ExecutionBinary): Promise<string> { return name; }
  private command(id: string, cwd: string, binary: string, args: string[]): string[] {
    return ['bash', '-c', runScript, 'clinavat-run', id, String(this.uid), String(this.gid), cwd, binary, ...args];
  }
  private runId(scope: ExecutionScope): string { return `${scope.userId ? 'run' : 'probe'}-${randomBytes(12).toString('hex')}`; }

  async spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
    const secrets = Object.entries(options.secrets ?? {});
    if (secrets.some(([name, value]) => !/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(value))) throw new Error('运行凭据格式无效');
    if (secrets.length && options.stdin === 'ignore') throw new Error('传递运行凭据需要标准输入');
    const machine = await this.attach(options.scope);
    const id = this.runId(options.scope);
    const env = secrets.length ? { ...options.env, CLINAVAT_SECRET_NAMES: secrets.map(([name]) => name).join(' ') } : options.env;
    const child = spawn(this.config.lxcBinary, this.execArguments(machine, this.command(id, options.cwd, binary, args), env), {
      env: childEnvironment(), detached: true, stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    if (secrets.length) child.stdin.on('error', () => undefined);
    for (const [, value] of secrets) child.stdin.write(`${value}\n`);
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
    const env = { ...guestEnvironment(this.services.plan), ...options.env };
    if (binary === 'mutagen') {
      if (machine.kind !== 'workspace') throw new Error('同步只能在用户的工作区虚拟机中运行');
      const started = await this.exec(machine, ['bash', '-c', daemonScript, 'clinavat-daemon', String(this.uid), String(this.gid), binary], { env });
      if (started.code !== 0) throw new Error(`无法启动虚拟机内的同步服务：${started.stderr.trim().slice(0, 300)}`);
    }
    return this.exec(machine, this.command(this.runId(options.scope), options.cwd ?? '/', binary, args),
      { env, timeout: options.timeout ?? 30_000, maxBytes: options.maxBytes, input: options.input });
  }

  async loginCommand(slotId: string, home: string, argv: string[], env: Record<string, string>): Promise<string> {
    const machine = await this.attach({ userId: '', slotId, paths: [home] });
    return formatLoginCommand({
      lxcBinary: this.config.lxcBinary, target: this.target(machine.name), project: this.config.lxdProject, home,
      uid: this.uid, gid: this.gid, env: { ...guestEnvironment(this.services.plan), ...env }, argv,
    });
  }

  async assertReleased(home: string, sessionId?: string): Promise<void> {
    await this.load();
    const shown = await this.checkedLxc(['list', `${this.config.lxdRemote}:`, '--format', 'json']);
    const workspaces = await workspaceCgroups(JSON.parse(shown.stdout) as InstanceRow[], this.config.lxdProject,
      name => this.machines.get(name)?.kind === 'workspace');
    await this.local.assertReleased(home, sessionId, workspaces);
    await assertGuestsReleased(this.machines.values(), home, sessionId, releasedScript, (machine, cmd) => this.exec(machine, cmd));
  }

  async revoke(userId: string, paths: string[]): Promise<void> {
    await this.load();
    for (const machine of this.machines.values()) {
      if (machine.kind === 'workspace' ? machine.owner !== userId : machine.occupant !== userId) continue;
      await this.serialized(machine, () => revokeMachineMounts(this.mountRunner, this.config.dataDir, machine, paths));
    }
  }

  async retire(kind: MachineKind, owner: string, remove: boolean): Promise<void> {
    await this.load();
    const name = machineName(kind, owner);
    const operation = async () => {
      await this.revokeMachine(kind, owner, remove ? 'retire-remove' : 'retire-stop');
      const result = await this.lxc([remove ? 'delete' : 'stop', '--force', this.target(name)], this.config.vmStartTimeoutMs);
      if (result.code !== 0 && !/not found|already stopped|not running/i.test(result.stderr)) {
        throw new Error(`LXD 操作失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
      }
    };
    const machine = this.machines.get(name);
    if (!machine) { await operation(); return; }
    await this.serialized(machine, async () => {
      await operation(); this.barriers.close(machine); machine.prepared = false;
      if (remove) this.machines.delete(name);
    });
  }

  async resources() {
    await this.load();
    const [rows, project] = await Promise.all([
      this.managedInstances(),
      this.lxc(['project', 'info', `${this.config.lxdRemote}:${this.config.lxdProject}`, '--format', 'json'], 15_000).catch(() => undefined),
    ]);
    return {
      machines: rows.map(row => describeResources(row, planResources(this.target(row.name), row, this.services.resources(row.kind)), this.resourceErrors.get(row.name))),
      quota: project?.code === 0 ? parseProjectQuota(project.stdout) : null,
    };
  }

  async applyResources(): Promise<void> {
    await this.load();
    for (const { name, kind, owner } of await this.managedInstances()) {
      await this.serialized(this.machine(kind, owner), async () => {
        const row = await this.instance(name);
        if (row) await this.fitResources(row, kind).catch((error: Error) => { this.resourceErrors.set(name, error.message); });
      });
    }
  }

  async health() {
    const image = async (alias: string) => (await this.lxc(['image', 'info', this.target(alias)], 15_000).catch(() => undefined))?.code === 0;
    const [agent, workspace] = await Promise.all([image(this.config.lxdImage), image(this.config.lxdWorkspaceImage)]);
    return { kind: this.kind, claude: agent, codex: agent, agy: agent, mutagen: workspace, ssh: agent && workspace };
  }
}
