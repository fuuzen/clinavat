import type { AccountCredentials } from '../accounts/credentials.js';
import type { AgentManager } from '../agent/manager.js';
import type { Store } from '../database.js';
import type { EventBus } from '../events.js';

export const DEFAULT_MAINTENANCE_MESSAGE =
  '系统正在维护中，当前为只读模式，暂不支持发起新对话或占用槽位操作。';

export interface MaintenanceState {
  enabled: boolean;
  message: string | null;
  enabledBy: string | null;
  enabledByUsername: string | null;
  enabledAt: string | null;
  updatedAt: string | null;
}

export interface MaintenanceActivity {
  activeSessions: number;
  activeTurns: number;
  pendingApprovals: number;
  idleResidentSessions: number;
  activeSlots: number;
  parkedSlots: number;
  readyToPublish: boolean;
}

interface MaintenanceRow {
  enabled: number;
  message: string | null;
  enabled_by: string | null;
  enabled_by_username: string | null;
  enabled_at: string | null;
  updated_at: string;
}

const emptyState: MaintenanceState = {
  enabled: false,
  message: null,
  enabledBy: null,
  enabledByUsername: null,
  enabledAt: null,
  updatedAt: null,
};

export class MaintenanceService {
  constructor(
    private readonly store: Store,
    private readonly agents: AgentManager,
    private readonly credentials: AccountCredentials,
    private readonly events: EventBus,
  ) {}

  isEnabled(): boolean {
    return this.store.get<{ enabled: number }>('SELECT enabled FROM maintenance_mode WHERE id=1')?.enabled === 1;
  }

  getState(): MaintenanceState {
    const row = this.store.get<MaintenanceRow>(`
      SELECT m.enabled, m.message, m.enabled_by, u.username AS enabled_by_username, m.enabled_at, m.updated_at
      FROM maintenance_mode m
      LEFT JOIN users u ON u.id = m.enabled_by
      WHERE m.id = 1
    `);
    if (!row) return { ...emptyState };
    return {
      enabled: row.enabled === 1,
      message: row.message ?? null,
      enabledBy: row.enabled_by ?? null,
      enabledByUsername: row.enabled_by_username ?? null,
      enabledAt: row.enabled_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  blockMessage(state: MaintenanceState = this.getState()): string {
    return state.message || DEFAULT_MAINTENANCE_MESSAGE;
  }

  setEnabled(enabled: boolean, adminUserId: string, message?: string | null): { state: MaintenanceState; reclaimedIdle: number } {
    const now = new Date().toISOString();
    const existing = this.store.get<{ enabled: number; message: string | null; enabled_at: string | null }>(
      'SELECT enabled,message,enabled_at FROM maintenance_mode WHERE id=1',
    );
    const normalized = message === undefined ? undefined : message?.trim() || null;
    const nextMessage = enabled
      ? (normalized !== undefined ? normalized : (existing?.enabled === 1 ? existing.message : null))
      : (normalized !== undefined ? normalized : null);
    const enabledBy = enabled ? adminUserId : null;
    const enabledAt = enabled ? (existing?.enabled === 1 && existing.enabled_at ? existing.enabled_at : now) : null;

    this.store.run(
      `INSERT INTO maintenance_mode(id,enabled,message,enabled_by,enabled_at,updated_at)
       VALUES(1,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         enabled=excluded.enabled,
         message=excluded.message,
         enabled_by=excluded.enabled_by,
         enabled_at=excluded.enabled_at,
         updated_at=excluded.updated_at`,
      enabled ? 1 : 0,
      nextMessage,
      enabledBy,
      enabledAt,
      now,
    );

    const reclaimedIdle = enabled ? this.agents.reclaimIdle() : 0;
    const state = this.getState();
    for (const user of this.store.all<{ id: string }>('SELECT id FROM users')) {
      this.events.broadcast(user.id, { type: 'maintenance_changed', payload: { maintenance: state } });
    }
    return { state, reclaimedIdle };
  }

  reclaimIdle(): number {
    return this.agents.reclaimIdle();
  }

  getActivity(): MaintenanceActivity {
    const activeSessions = this.store.get<{ count: number }>(
      "SELECT count(*) AS count FROM sessions WHERE lower(status) IN ('running','waiting','pausing','paused','streaming','waiting_approval')",
    )?.count ?? 0;
    const activeTurns = this.store.get<{ count: number }>(
      "SELECT count(*) AS count FROM session_turns WHERE lower(status) IN ('running','pausing','paused')",
    )?.count ?? 0;
    const pendingApprovals = this.store.get<{ count: number }>(
      "SELECT count(*) AS count FROM approvals WHERE lower(status)='pending'",
    )?.count ?? 0;
    const { idleResidentSessions } = this.agents.activitySummary();
    const { activeSlots, parkedSlots } = this.credentials.slotLeaseSummary();
    const readyToPublish = activeSessions === 0
      && activeTurns === 0
      && pendingApprovals === 0
      && idleResidentSessions === 0
      && activeSlots === 0;
    return {
      activeSessions,
      activeTurns,
      pendingApprovals,
      idleResidentSessions,
      activeSlots,
      parkedSlots,
      readyToPublish,
    };
  }
}
