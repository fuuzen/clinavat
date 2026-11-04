import { randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { Store } from '../database.js';

export type MachineKind = 'workspace' | 'slot';
export interface MachineIdentity { name: string; address: string; hostname: string | null; machineId: string | null }

const number = (address: string) => address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
const address = (value: number) => [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');

/**
 * Fixed addresses and identities of execution machines. The gateway binds egress by source address, and a slot's
 * hostname and machine ID are what its CLI reports, so all of them outlive any rebuild of the machine itself.
 */
export class MachinePlan {
  private readonly first: number;
  private readonly last: number;

  constructor(private readonly store: Store, range: string) {
    const [start, end] = range.split('-');
    if (!isIPv4(start!) || !isIPv4(end!) || number(start!) > number(end!)) throw new Error(`虚拟机地址范围无效：${range}`);
    this.first = number(start!);
    this.last = number(end!);
  }

  get(kind: MachineKind, ownerId: string): MachineIdentity | undefined {
    const row = this.store.get<{ name: string; address: string; hostname: string | null; machine_id: string | null }>(
      'SELECT name,address,hostname,machine_id FROM execution_machines WHERE kind=? AND owner_id=?', kind, ownerId);
    return row && { name: row.name, address: row.address, hostname: row.hostname, machineId: row.machine_id };
  }

  /** Returns the machine's identity, allocating one on first use. */
  ensure(kind: MachineKind, ownerId: string, name: string): MachineIdentity {
    return this.store.transaction(() => {
      const existing = this.get(kind, ownerId);
      if (existing) return existing;
      const used = new Set(this.store.all<{ address: string }>('SELECT address FROM execution_machines').map(row => number(row.address)));
      let next = this.first;
      while (next <= this.last && used.has(next)) next++;
      if (next > this.last) throw new Error('虚拟机地址已用尽，请扩大 CLINAVAT_VM_ADDRESSES');
      // Only slot machines carry an account's identity; a user's workspace machine keeps LXD's defaults.
      const hostname = kind === 'slot' ? `dev-${randomBytes(4).toString('hex')}` : null;
      const machineId = kind === 'slot' ? randomBytes(16).toString('hex') : null;
      this.store.run('INSERT INTO execution_machines(name,kind,owner_id,address,hostname,machine_id) VALUES(?,?,?,?,?,?)',
        name, kind, ownerId, address(next), hostname, machineId);
      return { name, address: address(next), hostname, machineId };
    });
  }

  list(): (MachineIdentity & { kind: MachineKind; ownerId: string })[] {
    return this.store.all<{ name: string; kind: MachineKind; owner_id: string; address: string; hostname: string | null; machine_id: string | null }>(
      'SELECT name,kind,owner_id,address,hostname,machine_id FROM execution_machines ORDER BY address').map(row => ({
      name: row.name, kind: row.kind, ownerId: row.owner_id, address: row.address, hostname: row.hostname, machineId: row.machine_id,
    }));
  }
}
