import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { Store } from '../database.js';
import { HttpError } from '../models.js';

export type DevHostApprovalHop = 'target' | 'jump';
export type DevHostApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface DevHostApproval {
  id: string;
  user_id: string;
  dev_host_id: string | null;
  hop: DevHostApprovalHop;
  hostname: string;
  pinned_ip: string;
  port: number;
  status: DevHostApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

export interface DevHostApprovalView extends DevHostApproval {
  username: string | null;
  dev_host_name: string | null;
  decided_by_username: string | null;
}

export interface DevHostApprovalFilter {
  userId?: string;
  status?: DevHostApprovalStatus;
  devHostId?: string;
}

export interface DevHostApprovalRequestInput {
  userId: string;
  devHostId?: string | null;
  hop: DevHostApprovalHop;
  hostname: string;
  pinnedIp: string;
  port: number;
}

const approvalViewSelect = `
  SELECT a.*, u.username AS username, h.name AS dev_host_name, d.username AS decided_by_username
  FROM dev_host_approvals a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN dev_hosts h ON h.id = a.dev_host_id
  LEFT JOIN users d ON d.id = a.decided_by
`;

function normalizeNote(note?: string): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

export class DevHostApprovalStore {
  constructor(private readonly store: Store) {}

  get(id: string): DevHostApprovalView | undefined {
    return this.store.get<DevHostApprovalView>(`${approvalViewSelect} WHERE a.id=?`, id);
  }

  list(filter?: DevHostApprovalFilter): DevHostApprovalView[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter?.userId) {
      clauses.push('a.user_id=?');
      params.push(filter.userId);
    }
    if (filter?.status) {
      clauses.push('a.status=?');
      params.push(filter.status);
    }
    if (filter?.devHostId) {
      clauses.push('a.dev_host_id=?');
      params.push(filter.devHostId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.store.all<DevHostApprovalView>(
      `${approvalViewSelect} ${where}
       ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, a.requested_at DESC`,
      ...params,
    );
  }

  findApproved(userId: string, pinnedIp: string, port: number): DevHostApproval | undefined {
    return this.store.get<DevHostApproval>(
      `SELECT * FROM dev_host_approvals
       WHERE user_id=? AND pinned_ip=? AND port=? AND status='approved'
       ORDER BY decided_at DESC, requested_at DESC LIMIT 1`,
      userId, pinnedIp, port,
    );
  }

  /** Synchronously checks whether a target has an active or pending private approval record. */
  hasPrivateRecord(userId: string, hostname: string, port: number, devHostId?: string, hop?: DevHostApprovalHop): boolean {
    return !!this.store.get(
      `SELECT 1 FROM dev_host_approvals
       WHERE user_id=? AND status IN ('pending','approved')
         AND ((hostname=? AND port=?) OR (? IS NOT NULL AND dev_host_id=? AND hop=?))
       LIMIT 1`,
      userId, hostname, port, devHostId ?? null, devHostId ?? null, hop ?? null,
    );
  }

  requestOrGet(input: DevHostApprovalRequestInput): DevHostApproval {
    const devHostId = input.devHostId ?? null;
    return this.store.transaction(() => {
      const approved = this.findApproved(input.userId, input.pinnedIp, input.port);
      if (approved) {
        if (devHostId && !approved.dev_host_id) {
          this.store.run('UPDATE dev_host_approvals SET dev_host_id=? WHERE id=?', devHostId, approved.id);
          return this.byId(approved.id)!;
        }
        return approved;
      }

      const pending = this.store.get<DevHostApproval>(
        `SELECT * FROM dev_host_approvals
         WHERE user_id=? AND pinned_ip=? AND port=? AND status='pending'
         ORDER BY requested_at DESC LIMIT 1`,
        input.userId, input.pinnedIp, input.port,
      );
      if (pending) {
        this.store.run(
          'UPDATE dev_host_approvals SET dev_host_id=?, hop=?, hostname=? WHERE id=?',
          devHostId ?? pending.dev_host_id, input.hop, input.hostname, pending.id,
        );
        return this.byId(pending.id)!;
      }

      const now = new Date().toISOString();
      const existing = this.store.get<DevHostApproval>(
        `SELECT * FROM dev_host_approvals
         WHERE user_id=? AND pinned_ip=? AND port=?
         ORDER BY requested_at DESC LIMIT 1`,
        input.userId, input.pinnedIp, input.port,
      );
      if (existing) {
        this.store.run(
          `UPDATE dev_host_approvals
           SET dev_host_id=?, hop=?, hostname=?, status='pending', requested_at=?, decided_at=NULL, decided_by=NULL, note=NULL
           WHERE id=?`,
          devHostId, input.hop, input.hostname, now, existing.id,
        );
        return this.byId(existing.id)!;
      }

      const id = randomUUID();
      this.store.run(
        `INSERT INTO dev_host_approvals(id,user_id,dev_host_id,hop,hostname,pinned_ip,port,status,requested_at)
         VALUES(?,?,?,?,?,?,?,'pending',?)`,
        id, input.userId, devHostId, input.hop, input.hostname, input.pinnedIp, input.port, now,
      );
      return this.byId(id)!;
    });
  }

  approve(id: string, adminUserId: string, note?: string): DevHostApproval {
    return this.decide(id, 'approved', adminUserId, note);
  }

  reject(id: string, adminUserId: string, note?: string): DevHostApproval {
    return this.decide(id, 'rejected', adminUserId, note);
  }

  revoke(id: string, adminUserId: string, note?: string): DevHostApproval {
    return this.decide(id, 'revoked', adminUserId, note);
  }

  revokeByHost(userId: string, devHostId: string, note?: string): DevHostApproval[] {
    const now = new Date().toISOString();
    const reason = normalizeNote(note);
    return this.store.transaction(() => {
      const affected = this.store.all<DevHostApproval>(
        `SELECT * FROM dev_host_approvals
         WHERE user_id=? AND dev_host_id=? AND status IN ('pending','approved')`,
        userId, devHostId,
      );
      if (!affected.length) return [];
      this.store.run(
        `UPDATE dev_host_approvals
         SET status='revoked', decided_at=?, note=COALESCE(?, note)
         WHERE user_id=? AND dev_host_id=? AND status IN ('pending','approved')`,
        now, reason, userId, devHostId,
      );
      return affected.map(row => this.byId(row.id)!);
    });
  }

  revokeByUser(userId: string, note?: string): DevHostApproval[] {
    const now = new Date().toISOString();
    const reason = normalizeNote(note);
    return this.store.transaction(() => {
      const affected = this.store.all<DevHostApproval>(
        `SELECT * FROM dev_host_approvals
         WHERE user_id=? AND status IN ('pending','approved')`,
        userId,
      );
      if (!affected.length) return [];
      this.store.run(
        `UPDATE dev_host_approvals
         SET status='revoked', decided_at=?, note=COALESCE(?, note)
         WHERE user_id=? AND status IN ('pending','approved')`,
        now, reason, userId,
      );
      return affected.map(row => this.byId(row.id)!);
    });
  }

  private decide(id: string, status: Exclude<DevHostApprovalStatus, 'pending'>, adminUserId: string, note?: string): DevHostApproval {
    const now = new Date().toISOString();
    const cleanedNote = normalizeNote(note);
    return this.store.transaction(() => {
      const existing = this.byId(id);
      if (!existing) throw new HttpError(404, '内网开发机审批记录不存在');
      this.store.run(
        'UPDATE dev_host_approvals SET status=?, decided_at=?, decided_by=?, note=? WHERE id=?',
        status, now, adminUserId, cleanedNote, id,
      );
      return this.byId(id)!;
    });
  }

  private byId(id: string): DevHostApproval | undefined {
    return this.store.get<DevHostApproval>('SELECT * FROM dev_host_approvals WHERE id=?', id);
  }
}
