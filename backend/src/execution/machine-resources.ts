import { z } from 'zod';
import type { Store } from '../database.js';
import type { MachineKind } from './machine-plan.js';

const resourcesSchema = z.object({
  cpu: z.number().int().min(1, 'vCPU 至少 1 个').max(64, 'vCPU 不能超过 64 个'),
  memoryMiB: z.number().int().min(256, '内存不能少于 256 MiB').max(262_144, '内存不能超过 256 GiB'),
  diskGiB: z.number().int().min(2, '磁盘不能少于 2 GiB').max(2048, '磁盘不能超过 2 TiB'),
}).strict();
export const machineResourceSettingsSchema = z.object({ slot: resourcesSchema, workspace: resourcesSchema }).strict();
export type MachineResources = z.infer<typeof resourcesSchema>;
export type MachineResourceSettings = z.infer<typeof machineResourceSettingsSchema>;

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const units: Record<string, number> = {
  B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 2 ** 10, MiB, GiB, TiB: 2 ** 40, PiB: 2 ** 50,
};

/** LXD sizes such as `1536MiB` or `8GB`; percentages and other forms are not a fixed size. */
export function parseSize(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(B|[kMGTP]B|[KMGTP]iB)?$/.exec(value?.trim() ?? '');
  return match ? Math.round(Number(match[1]) * units[match[2] ?? 'B']) : undefined;
}

/** Each kind of machine gets the same CPU, memory and root disk; LXD applies them per instance. */
export class MachineResourceSettingsStore {
  private cached?: MachineResourceSettings;

  constructor(private readonly store: Store, private readonly defaults: MachineResourceSettings) {}

  view(): MachineResourceSettings {
    if (this.cached) return this.cached;
    const rows = this.store.all<{ kind: MachineKind; cpu: number; memory_mib: number; disk_gib: number }>(
      'SELECT kind,cpu,memory_mib,disk_gib FROM machine_resources');
    const settings = structuredClone(this.defaults);
    for (const row of rows) settings[row.kind] = { cpu: row.cpu, memoryMiB: row.memory_mib, diskGiB: row.disk_gib };
    this.cached = settings;
    return settings;
  }

  update(settings: MachineResourceSettings): MachineResourceSettings {
    this.store.transaction(() => {
      for (const kind of ['slot', 'workspace'] as const) {
        const { cpu, memoryMiB, diskGiB } = settings[kind];
        this.store.run(`INSERT INTO machine_resources(kind,cpu,memory_mib,disk_gib) VALUES(?,?,?,?)
          ON CONFLICT(kind) DO UPDATE SET cpu=excluded.cpu,memory_mib=excluded.memory_mib,disk_gib=excluded.disk_gib`,
        kind, cpu, memoryMiB, diskGiB);
      }
    });
    this.cached = undefined;
    return this.view();
  }
}

/** What an instance holds now; a missing value is unlimited or not a plain count, such as pinned CPUs. */
export interface CurrentResources { cpu: number | null; memoryMiB: number | null; diskGiB: number | null }

export interface ResourceRow {
  type?: string; status: string; config?: Record<string, string>; devices?: Record<string, Record<string, string>>;
  expanded_config?: Record<string, string>; expanded_devices?: Record<string, Record<string, string>>;
}

export function currentResources(row: ResourceRow): CurrentResources {
  const cpu = row.expanded_config?.['limits.cpu'];
  const memory = parseSize(row.expanded_config?.['limits.memory']);
  const disk = parseSize(row.expanded_devices?.root?.size);
  return {
    cpu: cpu && /^\d+$/.test(cpu) ? Number(cpu) : null,
    memoryMiB: memory === undefined ? null : Math.round(memory / MiB),
    diskGiB: disk === undefined ? null : Math.round(disk / GiB * 100) / 100,
  };
}

/** `lxc` argument lists that bring an instance to the settings, and the changes that must wait. */
export interface ResourcePlan { commands: string[][]; pending: string[]; blocked: string[] }

/**
 * Stopped instances take every change. A running container takes CPU, memory and a larger disk at once; a running
 * VM waits for its next start. A VM disk never shrinks: its partition table and file system would be cut off.
 */
export function planResources(target: string, row: ResourceRow, desired: MachineResources): ResourcePlan {
  const plan: ResourcePlan = { commands: [], pending: [], blocked: [] };
  const running = row.status === 'Running';
  const container = row.type === 'container';
  const settings: string[] = [];
  if (row.expanded_config?.['limits.cpu'] !== String(desired.cpu)) {
    if (running && !container) plan.pending.push(`vCPU ${desired.cpu}`); else settings.push(`limits.cpu=${desired.cpu}`);
  }
  if (parseSize(row.expanded_config?.['limits.memory']) !== desired.memoryMiB * MiB) {
    if (running && !container) plan.pending.push(`内存 ${desired.memoryMiB} MiB`); else settings.push(`limits.memory=${desired.memoryMiB}MiB`);
  }
  if (settings.length) plan.commands.push(['config', 'set', target, ...settings]);
  const disk = parseSize(row.expanded_devices?.root?.size) ?? Infinity;
  if (disk !== desired.diskGiB * GiB) {
    const shrink = desired.diskGiB * GiB < disk;
    if (shrink && !container) plan.blocked.push(`磁盘 ${desired.diskGiB} GiB（虚拟机磁盘不能缩小，需重建）`);
    else if (running && (shrink || !container)) plan.pending.push(`磁盘 ${desired.diskGiB} GiB`);
    else {
      // The root disk usually comes from a profile; overriding copies it into the instance with the new size.
      plan.commands.push(row.devices?.root
        ? ['config', 'device', 'set', target, 'root', `size=${desired.diskGiB}GiB`]
        : ['config', 'device', 'override', target, 'root', `size=${desired.diskGiB}GiB`]);
    }
  }
  return plan;
}

/** One project resource as LXD counts it: the sum of every instance's limits, stopped ones included. */
export interface QuotaUsage { usage: number; limit: number | null }
export interface ProjectQuota {
  cpu: QuotaUsage | null; memory: QuotaUsage | null; disk: QuotaUsage | null;
  virtualMachines: QuotaUsage | null; containers: QuotaUsage | null;
}

export function parseProjectQuota(output: string): ProjectQuota | null {
  let parsed: { resources?: Record<string, Record<string, number>> };
  try { parsed = JSON.parse(output) as typeof parsed; } catch { return null; }
  const resources = parsed.resources ?? {};
  const read = (name: string): QuotaUsage | null => {
    const entry = resources[name];
    if (!entry) return null;
    const usage = entry.usage ?? entry.Usage;
    const limit = entry.limit ?? entry.Limit;
    return typeof usage === 'number' ? { usage, limit: typeof limit === 'number' && limit >= 0 ? limit : null } : null;
  };
  return { cpu: read('cpu'), memory: read('memory'), disk: read('disk'),
    virtualMachines: read('virtual-machines'), containers: read('containers') };
}

export function quotaError(error: Error): Error {
  return /limit|exceed/i.test(error.message)
    ? new Error(`${error.message}（LXD 项目配额不足：可在管理面板调低实例资源，或由宿主机管理员调高项目的 limits.memory、limits.cpu、limits.disk、limits.virtual-machines 或 limits.containers）`)
    : error;
}

export interface MachineResourceView {
  name: string; kind: MachineKind; owner: string; status: string;
  current: CurrentResources;
  /** Changes that apply on the next start, or for a slot once an administrator stops it. */
  pending: string[];
  /** Changes LXD cannot make in place. */
  blocked: string[];
  error: string | null;
}

export function describeResources(row: ResourceRow & { name: string; kind: MachineKind; owner: string }, plan: ResourcePlan,
  error: string | undefined): MachineResourceView {
  return {
    name: row.name, kind: row.kind, owner: row.owner, status: row.status, current: currentResources(row),
    // Commands left over for a running instance are the ones an earlier attempt could not apply.
    pending: [...plan.pending, ...(plan.commands.length && row.status === 'Running' ? ['部分配额尚未应用'] : [])],
    blocked: plan.blocked, error: error ?? null,
  };
}

/** Instance resources under the VM host; absent when CLIs run directly on the host. */
export interface MachineResourceHost {
  /** Every Clinavat instance with its resources, and the project's quota when LXD reports it. */
  resources(): Promise<{ machines: MachineResourceView[]; quota: ProjectQuota | null }>;
  /** Brings every instance as close to the settings as it can take while in its current state. */
  applyResources(): Promise<void>;
}

/** Fails when the settings would take more than the project allows, once every instance has caught up. */
export function assertWithinQuota(quota: ProjectQuota | null, machines: MachineResourceView[], settings: MachineResourceSettings) {
  if (!quota) return;
  const checks = [
    { label: 'vCPU', key: 'cpu', unit: 1, suffix: ' 个', quota: quota.cpu, field: 'cpu' },
    { label: '内存', key: 'memory', unit: MiB, suffix: ' MiB', quota: quota.memory, field: 'memoryMiB' },
    { label: '磁盘', key: 'disk', unit: GiB, suffix: ' GiB', quota: quota.disk, field: 'diskGiB' },
  ] as const;
  for (const check of checks) {
    if (!check.quota || check.quota.limit === null) continue;
    const projected = machines.reduce((total, view) => {
      const current = (view.current[check.field] ?? 0) * check.unit;
      const desired = settings[view.kind][check.field] * check.unit;
      // VM disks never shrink in place, so they keep counting at their current size.
      return total - current + (check.field === 'diskGiB' && view.kind === 'slot' ? Math.max(current, desired) : desired);
    }, check.quota.usage);
    if (projected > check.quota.limit && projected > check.quota.usage) {
      const show = (value: number) => `${Math.ceil(value / check.unit)}${check.suffix}`;
      throw new Error(`按新配额，现有实例共需${check.label} ${show(projected)}，超过 LXD 项目上限 ${show(check.quota.limit)}。`
        + `请降低配额、删除不用的实例，或由宿主机管理员调高项目的 limits.${check.key}`);
    }
  }
}
