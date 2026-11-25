import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import type { Store } from '../database.js';
import { HttpError } from '../models.js';
import { GatewayClient, gwctlPath } from './client.js';
import type { MachinePlan } from '../execution/machine-plan.js';
import { machineName } from '../execution/lxd-host.js';
import { defaultTimezone } from '../execution/timezones.js';

interface Health { problems: string[]; [key: string]: unknown }
interface MutationResult { changed: boolean; revision?: number; pending?: boolean; health?: Health }
export interface BindingInput { node: string | null; label?: string; interrupt: boolean; timezone?: string | null }
interface SlotTimezoneHost { setSlotTimezone(slotId: string, timezone: string | null): Promise<{ applied: boolean }> }
export interface GatewayBinding { node: string; label?: string }
export interface GatewayPreproxy {
  nodes: Record<string, unknown>[];
  groups: { tag: string; nodes: string[]; url?: string; interval?: string; tolerance?: number }[];
  routes: Record<string, string | string[]>;
}
export interface GatewayState {
  nodes: Record<string, unknown>[]; selected: string; rules: Record<string, unknown>[];
  dev_direct: string[]; forwards: Record<string, unknown>[]; sites: string[];
  source_policy: 'shared' | 'bound'; bindings: Record<string, GatewayBinding>; preproxy?: GatewayPreproxy;
}
interface GatewayAuditRow { id: number; username: string | null; action: string; revision: number | null; status: string; detail: string | null; created_at: string }

// These restart sing-box or switch the egress node, which drops running CLI connections.
// A single source binding switches at runtime and only cuts that source's connections when asked to.
const interrupting = new Set(['nodes.put', 'preproxy.put', 'proxies.put', 'selector.select', 'rules.put', 'dev_direct.put', 'source_policy.set', 'rollback']);

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

export function cidrContains(cidr: string, address: string): boolean {
  const [base, bits = '32'] = cidr.split('/');
  if (!isIPv4(base) || !isIPv4(address)) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4Number(base) / size) === Math.floor(ipv4Number(address) / size);
}

export class GatewayService {
  private bindingCache?: { at: number; state: Promise<{ policy: string; bindings: Record<string, GatewayBinding> } | undefined> };

  constructor(readonly client: GatewayClient, private readonly store: Store, private readonly machines?: MachinePlan,
    private readonly builderAddress?: string, private readonly timezoneHost?: SlotTimezoneHost) {}

  /** Under per-source binding, a slot machine without a node has no internet at all. */
  async assertBound(slotId: string): Promise<void> {
    const address = this.machines?.get('slot', slotId)?.address;
    if (!address || !this.client.target) return;
    if (!this.bindingCache || Date.now() - this.bindingCache.at > 15_000) {
      this.bindingCache = { at: Date.now(), state: this.client.call<{ state: GatewayState }>('state.get', {}, 20_000)
        .then(({ state }) => ({ policy: state.source_policy ?? 'shared', bindings: state.bindings ?? {} }), () => undefined) };
    }
    // An unreadable gateway does not block runs; the network itself still fails closed.
    const state = await this.bindingCache.state;
    if (state?.policy === 'bound' && !state.bindings[address]) {
      throw new HttpError(409, '该槽位尚未绑定网关出口，请管理员在「网关 → 出口绑定」中为它选择节点');
    }
  }

  async info() {
    const target = this.client.target;
    const publicKey = await this.client.publicKey();
    return {
      configured: !!target, target: target ? `${target.username}@${target.host}:${target.port}` : null,
      publicKey, fingerprint: await this.client.fingerprint(), gwctl: gwctlPath,
      installCommand: `./install.sh --wan-ip <网关 WAN 地址> --site <域名> --hub-key '${publicKey}'`,
    };
  }

  async overview() {
    const [status, state, audit, revisions] = await Promise.all([
      this.client.call<Record<string, unknown>>('status', {}, 60_000),
      this.client.call<{ state: GatewayState; infra: Record<string, unknown> }>('state.get'),
      this.client.call<Record<string, unknown>[]>('audit.tail', { limit: 100 }),
      this.client.call<number[]>('revisions.list'),
    ]);
    return { status, ...state, sources: this.sources(String(state.infra.pool_ip)), audit: audit.reverse(), revisions,
      hubAudit: this.hubAudit(), busySessions: this.busySessions() };
  }

  /** Every source the gateway can bind, named by what runs there. */
  private sources(poolIp: string) {
    // Every slot gets its address before its machine exists, so it can be bound before the first login.
    for (const slot of this.store.all<{ id: string }>('SELECT id FROM account_slots')) this.machines?.ensure('slot', slot.id, machineName('slot', slot.id));
    const slots = new Map(this.store.all<{ id: string; label: string }>('SELECT id,label FROM account_slots').map(slot => [slot.id, slot.label]));
    const users = new Map(this.store.all<{ id: string; username: string }>('SELECT id,username FROM users').map(user => [user.id, user.username]));
    return [
      { address: poolIp, kind: 'host', label: '号池机（宿主机）' },
      // Image builds need packages and CLI downloads; the builder uses this fixed address.
      ...(this.machines && this.builderAddress ? [{ address: this.builderAddress, kind: 'builder', label: '镜像构建' }] : []),
      ...(this.machines?.list() ?? []).map(machine => machine.kind === 'slot'
        ? { address: machine.address, kind: 'slot', label: `槽位 ${slots.get(machine.ownerId) ?? '已删除'}（${machine.ownerId}）`,
          ...(slots.has(machine.ownerId) ? { slotId: machine.ownerId, timezone: machine.timezone, defaultTimezone: defaultTimezone() } : {}) }
        : { address: machine.address, kind: 'workspace', label: `工作区 ${users.get(machine.ownerId) ?? '已删除用户'}` }),
    ];
  }

  read<T>(op: 'nodes.delay' | 'preproxy.delay' | 'connections') { return this.client.call<T>(op, {}, 60_000); }

  slotAt(address: string) {
    const machine = this.machines?.list().find(machine => machine.kind === 'slot' && machine.address === address);
    if (!machine || !this.timezoneHost || !this.store.get('SELECT id FROM account_slots WHERE id=?', machine.ownerId)) {
      throw new HttpError(409, '只能为现有槽位虚拟机设置时区');
    }
    return { id: machine.ownerId, timezone: machine.timezone };
  }

  async setBinding(userId: string, address: string, input: BindingInput) {
    const { timezone, ...binding } = input;
    if (timezone === undefined) return this.mutate(userId, 'binding.set', { address, ...binding });
    return this.client.serialize(async () => {
      const slot = this.slotAt(address);
      const timezoneChanged = timezone !== slot.timezone;
      let applied = false;
      if (timezoneChanged) {
        try { ({ applied } = await this.timezoneHost!.setSlotTimezone(slot.id, timezone)); }
        catch (error) {
          this.record(userId, 'slot.timezone', undefined, 'FAILED', String(error));
          throw error;
        }
      }
      let result: Awaited<ReturnType<GatewayService['applyMutation']>>;
      try { result = await this.applyMutation(userId, 'binding.set', { address, ...binding }); }
      catch (error) {
        if (timezoneChanged) {
          try { await this.timezoneHost!.setSlotTimezone(slot.id, slot.timezone); }
          catch (restoreError) {
            const detail = `出口绑定失败，且时区恢复失败：${String(restoreError)}；原错误：${String(error)}`;
            this.record(userId, 'slot.timezone', undefined, 'FAILED', detail);
            throw new HttpError(502, detail);
          }
          this.record(userId, 'slot.timezone', undefined, 'ROLLED_BACK', JSON.stringify({ slotId: slot.id, timezone: slot.timezone }));
        }
        throw error;
      }
      if (timezoneChanged) this.record(userId, 'slot.timezone', result.revision, 'APPLIED',
        JSON.stringify({ slotId: slot.id, previous: slot.timezone, timezone, applied }));
      return { ...result, changed: result.changed || timezoneChanged, timezone, timezoneApplied: applied };
    });
  }

  private busySessions(): number {
    return this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM sessions WHERE status IN ('running','waiting','pausing','paused')")!.count;
  }

  private hubAudit() {
    return this.store.all<GatewayAuditRow>(`SELECT a.id,u.username,a.action,a.revision,a.status,a.detail,a.created_at
      FROM gateway_audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100`);
  }

  private record(userId: string, action: string, revision: number | undefined, status: string, detail?: string) {
    this.store.run('INSERT INTO gateway_audit(user_id,action,revision,status,detail) VALUES(?,?,?,?,?)',
      userId, action, revision ?? null, status, detail?.slice(0, 2000) ?? null);
  }

  /**
   * Checks the new gateway revision before the gateway's automatic rollback fires. The pool machine's own route is not
   * part of it: the CLIs run in slot machines, and the host may leave directly or bind its users with user-egress.py.
   */
  private async verify(): Promise<string[]> {
    const problems: string[] = [];
    try {
      const status = await this.client.call<{ health: Health }>('status', {}, 60_000);
      problems.push(...status.health.problems);
    } catch (error) { problems.push(`无法读取网关状态：${error instanceof Error ? error.message : String(error)}`); }
    return problems;
  }

  async mutate(userId: string, op: string, args: Record<string, unknown>, force = false) {
    const busy = this.busySessions();
    if (interrupting.has(op) && busy > 0 && !force) {
      throw new HttpError(409, `有 ${busy} 个对话正在运行，此操作会中断它们的网络连接；确认后选择“允许中断”再试`);
    }
    return this.client.serialize(() => this.applyMutation(userId, op, args));
  }

  private async applyMutation(userId: string, op: string, args: Record<string, unknown>) {
    let result: MutationResult;
    try { result = await this.client.call<MutationResult>(op, args, op === 'cert.issue' ? 700_000 : 150_000); }
    catch (error) {
      this.record(userId, op, undefined, 'FAILED', error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (op === 'rollback') {
      this.bindingCache = undefined;
      this.record(userId, op, Number(args.revision), 'ROLLED_BACK');
      return result;
    }
    if (!result.pending || result.revision === undefined) {
      this.bindingCache = undefined;
      this.record(userId, op, result.revision, result.changed ? 'APPLIED' : 'UNCHANGED');
      return result;
    }
    const problems = await this.verify();
    if (problems.length) {
      const rollback = await this.client.call('rollback', { revision: result.revision, reason: 'hub verification failed' })
        .then(() => '已回滚', error => `回滚请求失败，网关将在确认超时后自动回滚：${error instanceof Error ? error.message : String(error)}`);
      this.record(userId, op, result.revision, 'ROLLED_BACK', problems.join('；'));
      throw new HttpError(502, `号池机验证未通过，${rollback}：${problems.join('；')}`);
    }
    await this.client.call('confirm', { revision: result.revision });
    this.bindingCache = undefined;
    this.record(userId, op, result.revision, 'CONFIRMED');
    return { ...result, confirmed: true };
  }

  /** Development host addresses, so the admin can approve them for the direct list. */
  async devHosts(devDirect: string[], lanDirect: string[]) {
    const hosts = this.store.all<{
      id: string; user_id: string; name: string; host: string; port: number;
      jump_host: string | null; jump_port: number | null; username: string;
    }>(
      `SELECT h.id,h.user_id,h.name,h.host,h.port,h.jump_host,h.jump_port,u.username FROM dev_hosts h JOIN users u ON u.id=h.user_id
       WHERE h.kind='ssh' ORDER BY u.username,h.name`);
    return Promise.all(hosts.map(async host => {
      const firstHost = host.jump_host ?? host.host;
      const firstPort = host.jump_host ? host.jump_port! : host.port;
      const addresses = isIPv4(firstHost) ? [firstHost]
        : await lookup(firstHost, { all: true, family: 4 }).then(items => items.map(item => item.address), () => []);
      const approval = this.store.get<{ status: string }>(
        `SELECT status FROM dev_host_approvals
         WHERE user_id=? AND port=? AND (dev_host_id=? OR hostname=? OR pinned_ip=?)
         ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, requested_at DESC LIMIT 1`,
        host.user_id, firstPort, host.id, firstHost, addresses[0] ?? '',
      );
      return {
        id: host.id, name: host.name, owner: host.username,
        approvalStatus: approval?.status ?? null,
        // Behind a jump host only the jump host is reached from the pool machine.
        endpoints: [{
          host: firstHost, resolved: addresses.length > 0,
          addresses: addresses.map(address => ({
            address,
            covered: devDirect.some(cidr => cidrContains(cidr, address)) ? 'dev'
              : lanDirect.some(cidr => cidrContains(cidr, address)) ? 'lan' : null,
          })),
        }],
      };
    }));
  }
}
