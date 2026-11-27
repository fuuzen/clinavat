import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import type { CommandResult } from '../runtime/types.js';
import { shellQuote } from '../runtime/types.js';
import type { MachineKind, MachineIdentity } from './machine-plan.js';
import type { MachineResources, ResourceRow } from './machine-resources.js';
import type { ExecutionScope } from './types.js';

export interface MountedDisk { device: string; source: string; target: string; readonly: boolean }
export interface MountSpec { source: string; target: string; readonly: boolean }
export interface LxdMountRoots { dataDir: string; workspaceDir?: string }
export interface LxdMountRunner {
  target(name: string): string;
  checkedLxc(args: string[], timeout?: number): Promise<CommandResult>;
}
export interface Machine {
  name: string;
  kind: MachineKind;
  /** The slot ID or user ID the machine belongs to. */
  owner: string;
  mounts: Map<string, MountedDisk>;
  prepared: boolean;
  queue: Promise<unknown>;
  /** A slot machine's current user, whose files are mounted; cleared by the next hand-over. */
  occupant?: string;
}
export interface InstanceRow extends ResourceRow { name: string; state?: { pid?: number } }

export const ownerKey = 'user.clinavat.owner';
export const kindKey = 'user.clinavat.kind';

/** Linux system root prefixes that a custom mount target must never shadow inside a guest VM. */
const reservedTargetPrefixes = [
  '/bin', '/sbin', '/usr', '/lib', '/lib64', '/etc', '/proc', '/sys', '/dev',
  '/run', '/var', '/root', '/home', '/boot', '/opt', '/srv', '/tmp',
] as const;

export const deviceName = (target: string) => `m-${createHash('sha256').update(target).digest('hex').slice(0, 24)}`;
// LXD names allow neither underscores nor arbitrary length, which slot IDs do.
export const machineName = (kind: MachineKind, owner: string) => kind === 'workspace' ? `u-${owner}`
  : `s-${createHash('sha256').update(owner).digest('hex').slice(0, 16)}`;
export const slotHome = (dataDir: string, slotId: string) => join(dataDir, 'slots', slotId);
export const userDirectory = (dataDir: string, userId: string) => join(dataDir, 'users', userId);

function stripTrailingSlashes(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * Validates a custom guest mount target differing from its host source.
 * Rejects non-normalized paths, Linux system prefixes, and Hub-managed roots (`dataDir` / `workspaceDir`).
 */
export function validateCustomMountTarget(target: string, protectedRoots: readonly string[] = []): string {
  if (!target || /[\0\r\n]/.test(target) || !posix.isAbsolute(target)) {
    throw new Error(`挂载目标路径无效：${target}`);
  }
  const segments = target.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    throw new Error(`挂载目标路径必须是规范化的 POSIX 绝对路径：${target}`);
  }
  const normalized = posix.normalize(target);
  if (normalized === '/' || normalized !== target || target.endsWith('/')) {
    throw new Error(`挂载目标路径必须是规范化的 POSIX 绝对路径：${target}`);
  }
  for (const prefix of reservedTargetPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      throw new Error(`挂载目标路径不能位于系统保留目录 ${prefix} 下：${target}`);
    }
  }
  for (const root of protectedRoots) {
    if (!root || !posix.isAbsolute(root)) continue;
    const cleanRoot = stripTrailingSlashes(root);
    if (cleanRoot === '/') continue;
    // Block both mounting inside a Hub-managed tree and mounting an ancestor that would shadow it.
    if (normalized === cleanRoot || normalized.startsWith(`${cleanRoot}/`) || cleanRoot.startsWith(`${normalized}/`)) {
      throw new Error(`挂载目标路径不能覆盖或落入托管目录 ${cleanRoot}：${target}`);
    }
  }
  return normalized;
}

/**
 * Ensures a mount source neither exposes all slots by mounting `slots/` or an ancestor of it,
 * nor mounts another slot's home into this machine.
 */
function assertAllowedSlotPath(slotsDir: string, ownSlotDir: string | undefined, candidate: string): void {
  const resolved = resolve(candidate);
  const resolvedSlots = resolve(slotsDir);
  if (resolved === resolvedSlots || resolvedSlots.startsWith(resolved === sep ? sep : resolved + sep)) {
    throw new Error('挂载源目录不能包含全部槽位目录');
  }
  if (!resolved.startsWith(resolvedSlots + sep)) return;
  const own = ownSlotDir ? resolve(ownSlotDir) : undefined;
  if (!own || (resolved !== own && !resolved.startsWith(own + sep))) {
    throw new Error('槽位目录只能在该槽位的虚拟机中使用');
  }
}

export function parseLoadedMounts(
  dataDir: string,
  kind: MachineKind,
  devices: Record<string, Record<string, string>> | undefined,
): { mounts: Map<string, MountedDisk>; occupant?: string } {
  const mounts = new Map<string, MountedDisk>();
  for (const [device, entry] of Object.entries(devices ?? {})) {
    if (entry.type !== 'disk' || !entry.path || entry.path === '/') continue;
    mounts.set(entry.path, { device, source: entry.source ?? entry.path, target: entry.path, readonly: entry.readonly === 'true' });
  }
  const users = join(dataDir, 'users') + sep;
  const occupant = kind === 'slot'
    ? [...mounts.keys()].find(path => path.startsWith(users) && path.endsWith(`${sep}engine-state`))?.slice(users.length).split(sep)[0]
    : undefined;
  return { mounts, occupant };
}

export function planScopeMounts(
  roots: LxdMountRoots,
  kind: MachineKind,
  scope: ExecutionScope,
  extraProtectedTargets: readonly string[] = [],
): MountSpec[] {
  const { dataDir, workspaceDir } = roots;
  const user = scope.userId ? userDirectory(dataDir, scope.userId) : undefined;
  const keys = scope.userId ? join(dataDir, 'run', 'keys', scope.userId) : undefined;
  const slotsDir = join(resolve(dataDir), 'slots');
  const ownSlotDir = scope.slotId ? join(slotsDir, scope.slotId) : undefined;
  const protectedTargets = [...new Set([
    resolve(dataDir),
    ...(workspaceDir ? [resolve(workspaceDir)] : []),
    ...extraProtectedTargets,
  ])];

  const explicitMounts: MountSpec[] = [
    ...scope.paths.map(path => ({ source: path, target: path, readonly: false })),
    ...(scope.readOnlyPaths ?? []).map(path => ({ source: path, target: path, readonly: true })),
    ...(scope.mounts ?? []).map(mount => ({ source: mount.source, target: mount.target ?? mount.source, readonly: !!mount.readonly })),
  ];
  for (const item of explicitMounts) {
    assertAllowedSlotPath(slotsDir, ownSlotDir, item.source);
    if (item.target !== item.source) validateCustomMountTarget(item.target, protectedTargets);
  }

  const defaults: MountSpec[] = [
    ...(kind === 'slot'
      ? (user ? [{ source: join(user, 'engine-state'), target: join(user, 'engine-state'), readonly: false }] : [])
      : [{ source: join(user!, 'mutagen'), target: join(user!, 'mutagen'), readonly: false }]),
    ...(user ? [
      { source: join(user, '.ssh'), target: join(user, '.ssh'), readonly: true },
      { source: keys!, target: keys!, readonly: true },
    ] : []),
    ...(kind === 'workspace' ? [{ source: join(user!, 'mutagen-ssh'), target: join(user!, 'mutagen-ssh'), readonly: true }] : []),
  ];

  // Process writable mounts before read-only mounts so a writable mount takes precedence for the same target.
  const ordered = [
    ...defaults.filter(item => !item.readonly), ...explicitMounts.filter(item => !item.readonly),
    ...defaults.filter(item => item.readonly), ...explicitMounts.filter(item => item.readonly),
  ];
  const planned = new Map<string, MountSpec>();
  for (const spec of ordered) {
    const existing = planned.get(spec.target);
    if (!existing) { planned.set(spec.target, spec); continue; }
    if (resolve(existing.source) !== resolve(spec.source)) throw new Error(`挂载目标路径冲突：${spec.target}`);
  }
  return [...planned.values()];
}

export async function attachMounts(runner: LxdMountRunner, roots: LxdMountRoots, machine: Machine, scope: ExecutionScope): Promise<void> {
  const logicalDataDir = resolve(roots.dataDir);
  const realDataDir = await realpath(logicalDataDir).catch(() => logicalDataDir);
  const logicalWorkspaceDir = roots.workspaceDir ? resolve(roots.workspaceDir) : undefined;
  const realWorkspaceDir = logicalWorkspaceDir ? await realpath(logicalWorkspaceDir).catch(() => logicalWorkspaceDir) : undefined;
  const specs = planScopeMounts(roots, machine.kind, scope, [
    realDataDir,
    ...(realWorkspaceDir ? [realWorkspaceDir] : []),
  ]);

  // Resolve realpath from `slots/` (or `dataDir`) before joining `slotId` so a not-yet-created slot directory
  // under a symlinked `dataDir` still matches its canonical parent path.
  const logicalSlotsDir = join(logicalDataDir, 'slots');
  const realSlotsDir = await realpath(logicalSlotsDir).catch(() => join(realDataDir, 'slots'));
  const ownLogicalSlot = scope.slotId ? join(logicalSlotsDir, scope.slotId) : undefined;
  const ownRealSlot = scope.slotId ? join(realSlotsDir, scope.slotId) : undefined;

  for (const { source, target, readonly } of specs) {
    await mkdir(source, { recursive: true, mode: 0o700 });
    // LXD refuses a source reached through a symlink, such as the data directory's run link.
    const realSource = await realpath(source);
    assertAllowedSlotPath(logicalSlotsDir, ownLogicalSlot, realSource);
    assertAllowedSlotPath(realSlotsDir, ownRealSlot, realSource);

    const existing = machine.mounts.get(target);
    if (existing) {
      if (existing.source !== realSource) {
        throw new Error(`挂载目标路径 ${target} 已被其他目录占用，拒绝覆盖现有挂载`);
      }
      if (existing.readonly === readonly || !existing.readonly) continue;
      await runner.checkedLxc(['config', 'device', 'remove', runner.target(machine.name), existing.device]);
      machine.mounts.delete(target);
    }

    const device = deviceName(target);
    await runner.checkedLxc([
      'config', 'device', 'add', runner.target(machine.name), device, 'disk',
      `source=${realSource}`, `path=${target}`, ...(readonly ? ['readonly=true'] : []),
    ]).catch((error: Error) => {
      if (/not allowed|restricted/i.test(error.message)) {
        throw new Error(`${error.message}（目录不在 LXD 项目的挂载白名单中，本机项目目录请用 egress-bindings.sh prepare-containers --local-root 加入）`);
      }
      throw /\bport|pci/i.test(error.message)
        ? new Error(`${error.message}（虚拟机设备端口可能已用尽：每个挂载目录各占一个。调高 limits.max_bus_ports 后需重启该虚拟机）`)
        : error;
    });
    machine.mounts.set(target, { device, source: realSource, target, readonly });
  }
}

export function buildInitArgs(options: {
  target: (name: string) => string; machine: Machine; container: boolean; image: string;
  vmBusPorts: number; resources: MachineResources; uid: number; gid: number;
}): string[] {
  const { target, machine, container, image, vmBusPorts, resources, uid, gid } = options;
  const idmap = uid === gid ? `both ${uid} ${uid}` : `uid ${uid} ${uid}\ngid ${gid} ${gid}`;
  return [
    'init', ...(container
      // Its profile isolates root and the remaining uid range. Only the Hub's uid/gid are mapped directly for
      // ordinary bind mounts: LXD forbids shift=true when a project restricts source paths.
      ? [target(image), target(machine.name), '--profile', 'workspace']
      // Agents run arbitrary code: a slot gets its own kernel.
      : [target(image), target(machine.name), '--vm', '-c', `limits.max_bus_ports=${vmBusPorts}`]),
    '-c', `limits.cpu=${resources.cpu}`, '-c', `limits.memory=${resources.memoryMiB}MiB`, '-d', `root,size=${resources.diskGiB}GiB`,
    '-c', `raw.idmap=${idmap}`, '-c', `${kindKey}=${machine.kind}`, '-c', `${ownerKey}=${machine.owner}`,
  ];
}

export async function ensureNetworkAddress(
  runner: LxdMountRunner, machine: Machine, row: InstanceRow | undefined, identity: MachineIdentity,
): Promise<void> {
  // The gateway chooses the egress by this address.
  if (row?.devices?.eth0?.['ipv4.address'] === identity.address) return;
  await runner.checkedLxc(row?.devices?.eth0
    ? ['config', 'device', 'set', runner.target(machine.name), 'eth0', `ipv4.address=${identity.address}`]
    : ['config', 'device', 'override', runner.target(machine.name), 'eth0', `ipv4.address=${identity.address}`]);
}

export async function rebindRuntimeMounts(
  runner: LxdMountRunner, dataDir: string, machine: Machine,
  devices: Record<string, Record<string, string>> | undefined, running: boolean,
): Promise<void> {
  const runtime = resolve(dataDir, 'run') + sep;
  for (const [name, device] of Object.entries(devices ?? {})) {
    if (device.type !== 'disk' || !device.path) continue;
    const sourcePath = device.source ?? device.path;
    const hostPath = resolve(device.path).startsWith(runtime)
      ? device.path : resolve(sourcePath).startsWith(runtime) ? sourcePath : undefined;
    if (!hostPath) continue;
    // systemd recreates the runtime tree when the Hub stops; surviving guests still hold its old directory inodes.
    await mkdir(hostPath, { recursive: true, mode: 0o700 });
    const source = await realpath(hostPath);
    if (!running) {
      await runner.checkedLxc(['config', 'device', 'set', runner.target(machine.name), name, `source=${source}`]);
      const mounted = machine.mounts.get(device.path);
      if (mounted) mounted.source = source;
      continue;
    }
    await runner.checkedLxc(['config', 'device', 'remove', runner.target(machine.name), name]);
    machine.mounts.delete(device.path);
    const options = Object.entries({ ...device, source }).filter(([key]) => key !== 'type').map(([key, value]) => `${key}=${value}`);
    await runner.checkedLxc(['config', 'device', 'add', runner.target(machine.name), name, 'disk', ...options]);
    machine.mounts.set(device.path, { device: name, source, target: device.path, readonly: device.readonly === 'true' });
  }
}

/** The only directories a slot machine keeps mounted across users: its home and its usage probe directory. */
export function slotOwnMounts(dataDir: string, slotId: string): string[] {
  return [slotHome(dataDir, slotId), join(dataDir, 'run', 'usage-probes', slotId)];
}

/** Checks LXD's device list rather than the Hub's record, which can miss devices added outside it. */
export function assertOnlySlotMounts(
  dataDir: string, machine: Machine, devices: Record<string, Record<string, string>> | undefined,
): void {
  const kept = new Set(slotOwnMounts(dataDir, machine.owner));
  const remaining = [...parseLoadedMounts(dataDir, machine.kind, devices).mounts.keys()].filter(target => !kept.has(target));
  if (remaining.length) throw new Error(`槽位虚拟机仍挂载上一位用户的目录，已停止清理：${remaining.slice(0, 3).join('、')}`);
}

export async function removeNonSlotMounts(runner: LxdMountRunner, dataDir: string, machine: Machine): Promise<void> {
  const kept = new Set(slotOwnMounts(dataDir, machine.owner));
  for (const [target, mount] of [...machine.mounts.entries()]) {
    if (kept.has(target)) continue;
    await runner.checkedLxc(['config', 'device', 'remove', runner.target(machine.name), mount.device]);
    machine.mounts.delete(target);
  }
}

export async function revokeMachineMounts(runner: LxdMountRunner, dataDir: string, machine: Machine, paths: string[]): Promise<void> {
  const candidates = new Set<string>();
  for (const path of paths) {
    candidates.add(path);
    candidates.add(resolve(path));
    const real = await realpath(path).catch(() => undefined);
    if (real) candidates.add(real);
  }
  const protectedTarget = machine.kind === 'slot' ? slotHome(dataDir, machine.owner) : undefined;
  for (const [target, mount] of [...machine.mounts.entries()]) {
    if (target === protectedTarget) continue;
    if (!candidates.has(target) && !candidates.has(mount.source)) continue;
    await runner.checkedLxc(['config', 'device', 'remove', runner.target(machine.name), mount.device]);
    machine.mounts.delete(target);
  }
}

export function parseManagedInstances(stdout: string): (InstanceRow & { kind: MachineKind; owner: string })[] {
  return (JSON.parse(stdout) as InstanceRow[]).flatMap(row => {
    const kind = row.config?.[kindKey];
    const owner = row.config?.[ownerKey];
    return (kind === 'workspace' || kind === 'slot') && owner && row.name === machineName(kind, owner) ? [{ ...row, kind, owner }] : [];
  });
}

export async function prepareStoppedInstance(options: {
  runner: LxdMountRunner; dataDir: string; machine: Machine; row: InstanceRow | undefined;
  identity: MachineIdentity; container: boolean; image: string; vmBusPorts: number; vmStartTimeoutMs: number;
  resources: MachineResources; uid: number; gid: number;
  fitResources: (row: InstanceRow, kind: MachineKind) => Promise<void>;
  onResourceError: (message: string) => void; quotaError: (error: Error) => Error;
}): Promise<void> {
  const { runner, dataDir, machine, row, identity, container, image, vmBusPorts, vmStartTimeoutMs, resources, uid, gid } = options;
  if (!row) {
    await runner.checkedLxc(buildInitArgs({
      target: name => runner.target(name), machine, container, image, vmBusPorts, resources, uid, gid,
    }), vmStartTimeoutMs).catch((error: Error) => { throw options.quotaError(error); });
  }
  if (row && (row.config?.[kindKey] !== machine.kind || row.config?.[ownerKey] !== machine.owner)) {
    await runner.checkedLxc(['config', 'set', runner.target(machine.name), `${kindKey}=${machine.kind}`, `${ownerKey}=${machine.owner}`]);
  }
  // Bus ports and addresses can only change while stopped; older instances catch up on their next start.
  if (row && !container && Number(row.expanded_config?.['limits.max_bus_ports'] ?? 0) < vmBusPorts) {
    await runner.checkedLxc(['config', 'set', runner.target(machine.name), `limits.max_bus_ports=${vmBusPorts}`]);
  }
  // Settings saved while the instance was running catch up here; a refusal keeps old resources and surfaces in admin panel.
  if (row) await options.fitResources(row, machine.kind).catch((error: Error) => { options.onResourceError(error.message); });
  await ensureNetworkAddress(runner, machine, row, identity);
  await rebindRuntimeMounts(runner, dataDir, machine, row?.devices, false);
}

export async function assertGuestsReleased(
  machines: Iterable<Machine>, home: string, sessionId: string | undefined, releasedScript: string,
  exec: (machine: Machine, command: string[]) => Promise<CommandResult>,
): Promise<void> {
  for (const machine of machines) {
    if (!machine.mounts.has(home)) continue;
    const result = await exec(machine, ['bash', '-c', releasedScript, 'clinavat-released', home, sessionId ?? '']);
    if (result.code !== 0) {
      // A stopped guest has no processes; anything else cannot be proven safe for a hand-off.
      if (/not running/i.test(result.stderr)) continue;
      throw new Error(`无法确认虚拟机是否已释放槽位：${result.stderr.trim().slice(0, 300)}`);
    }
    const survivors = result.stdout.trim().split('\n').filter(Boolean);
    if (survivors.length) throw new Error(`槽位仍被虚拟机内的进程 ${survivors.join(', ')} 使用，已保留用户数据并暂停交接`);
  }
}

export function formatLoginCommand(options: {
  lxcBinary: string; target: string; project: string; home: string;
  uid: number; gid: number; env: Record<string, string | undefined>; argv: string[];
}): string {
  const variables = { ...options.env };
  delete variables.TZ;
  return [
    options.lxcBinary, 'exec', options.target, '--project', options.project, '-t', '--cwd', options.home,
    ...Object.entries(variables).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    // Login commands can be pasted after a timezone change. Resolve the zone from the guest at execution time.
    '--', 'setpriv', `--reuid=${options.uid}`, `--regid=${options.gid}`, '--clear-groups', '--', 'env', '-u', 'TZ', ...options.argv,
  ].map(shellQuote).join(' ');
}
