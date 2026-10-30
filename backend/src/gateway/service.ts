import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import type { Store } from '../database.js';
import { HttpError } from '../models.js';
import { GatewayClient, gwctlPath } from './client.js';

interface Health { problems: string[]; [key: string]: unknown }
interface MutationResult { changed: boolean; revision?: number; pending?: boolean; health?: Health }
export interface GatewayState {
  nodes: Record<string, unknown>[]; selected: string; rules: Record<string, unknown>[];
  dev_direct: string[]; forwards: Record<string, unknown>[]; sites: string[];
}
interface GatewayAuditRow { id: number; username: string | null; action: string; revision: number | null; status: string; detail: string | null; created_at: string }

// These restart sing-box or switch the egress node, which drops running CLI connections.
const interrupting = new Set(['nodes.put', 'selector.select', 'rules.put', 'dev_direct.put', 'rollback']);

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
  constructor(readonly client: GatewayClient, private readonly store: Store) {}

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
    return { status, ...state, audit: audit.reverse(), revisions, hubAudit: this.hubAudit(), busySessions: this.busySessions() };
  }

  read<T>(op: 'nodes.delay' | 'connections') { return this.client.call<T>(op, {}, 60_000); }

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

  /** Checks the new gateway revision from the pool machine before the gateway's automatic rollback fires. */
  private async verify(): Promise<string[]> {
    const problems: string[] = [];
    try { await fetch('https://api.anthropic.com/', { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
    catch (error) { problems.push(`号池机无法访问 api.anthropic.com：${error instanceof Error ? error.message : String(error)}`); }
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
    return this.client.serialize(async () => {
      let result: MutationResult;
      try { result = await this.client.call<MutationResult>(op, args, op === 'cert.issue' ? 700_000 : 150_000); }
      catch (error) {
        this.record(userId, op, undefined, 'FAILED', error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (op === 'rollback') {
        this.record(userId, op, Number(args.revision), 'ROLLED_BACK');
        return result;
      }
      if (!result.pending || result.revision === undefined) {
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
      this.record(userId, op, result.revision, 'CONFIRMED');
      return { ...result, confirmed: true };
    });
  }

  /** Development host addresses, so the admin can approve them for the direct list. */
  async devHosts(devDirect: string[], lanDirect: string[]) {
    const hosts = this.store.all<{ id: string; name: string; host: string; jump_host: string | null; username: string }>(
      `SELECT h.id,h.name,h.host,h.jump_host,u.username FROM dev_hosts h JOIN users u ON u.id=h.user_id
       WHERE h.kind='ssh' ORDER BY u.username,h.name`);
    return Promise.all(hosts.map(async host => ({
      id: host.id, name: host.name, owner: host.username,
      // Behind a jump host only the jump host is reached from the pool machine.
      endpoints: await Promise.all([host.jump_host ?? host.host].map(async name => {
        const addresses = isIPv4(name) ? [name]
          : await lookup(name, { all: true, family: 4 }).then(items => items.map(item => item.address), () => []);
        return {
          host: name, resolved: addresses.length > 0,
          addresses: addresses.map(address => ({
            address,
            covered: devDirect.some(cidr => cidrContains(cidr, address)) ? 'dev'
              : lanDirect.some(cidr => cidrContains(cidr, address)) ? 'lan' : null,
          })),
        };
      })),
    })));
  }
}
