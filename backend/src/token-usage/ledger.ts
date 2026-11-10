import type { Store } from '../database.js';
import { codexTotals, codexUsage, type UsageRecord } from './meters.js';

export interface UsageOwner { userId: string; slotId: string; sessionId: string; turnId: string | null; engine: 'claude' | 'codex' }

export type TokenUsageUpdate = { records: UsageRecord[] } | { codex: { model: string; tokenUsage: unknown } };

export interface UsageRow {
  user_id: string; username: string | null; slot_id: string; slot_label: string | null;
  engine: 'claude' | 'codex'; model: string;
  input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; output_tokens: number; reasoning_tokens: number;
  cost_usd: number | null;
  /** Records whose model is missing from the price snapshot, so `cost_usd` leaves them out. */
  unpriced: number;
  last_used_at: string;
}

/** Token use of every turn, kept per user and slot; rows outlive the conversations they came from. */
export class TokenUsageLedger {
  constructor(private store: Store) {}

  apply(owner: UsageOwner, update: TokenUsageUpdate): void {
    this.store.transaction(() => {
      if ('records' in update) { this.insert(owner, update.records); return; }
      const usage = update.codex.tokenUsage as { total?: unknown; last?: unknown } | null;
      const total = codexTotals(usage?.total), last = codexTotals(usage?.last);
      const session = this.store.get<{ token_usage_cursor: string | null }>('SELECT token_usage_cursor FROM sessions WHERE id=?', owner.sessionId);
      if (!total || !last || !session) return;
      const cursor = session.token_usage_cursor ? codexTotals(JSON.parse(session.token_usage_cursor)) ?? null : null;
      const record = codexUsage(update.codex.model, total, last, cursor);
      if (record) this.insert(owner, [record]);
      this.store.run('UPDATE sessions SET token_usage_cursor=? WHERE id=?', JSON.stringify(total), owner.sessionId);
    });
  }

  /** Totals per user, slot and model since `since` (UTC, SQLite format); `userId` limits them to one user. */
  report(since: string | null, userId?: string): UsageRow[] {
    return this.store.all<UsageRow>(`SELECT t.user_id,u.username,t.slot_id,s.label AS slot_label,t.engine,t.model,
        SUM(t.input_tokens) AS input_tokens,SUM(t.cache_read_tokens) AS cache_read_tokens,
        SUM(t.cache_write_tokens) AS cache_write_tokens,SUM(t.output_tokens) AS output_tokens,
        SUM(t.reasoning_tokens) AS reasoning_tokens,SUM(t.cost_usd) AS cost_usd,SUM(t.cost_usd IS NULL) AS unpriced,
        MAX(t.recorded_at) AS last_used_at
      FROM token_usage t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN account_slots s ON s.id=t.slot_id
      WHERE (?1 IS NULL OR t.user_id=?1) AND (?2 IS NULL OR t.recorded_at>=?2)
      GROUP BY t.user_id,t.slot_id,t.engine,t.model ORDER BY u.username,t.slot_id,t.model`, userId ?? null, since);
  }

  private insert(owner: UsageOwner, records: UsageRecord[]): void {
    for (const record of records) {
      this.store.run(`INSERT INTO token_usage(user_id,slot_id,session_id,turn_id,engine,model,input_tokens,cache_read_tokens,
        cache_write_tokens,output_tokens,reasoning_tokens,cost_usd,cost_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      owner.userId, owner.slotId, owner.sessionId, owner.turnId, owner.engine, record.model, record.inputTokens,
      record.cacheReadTokens, record.cacheWriteTokens, record.outputTokens, record.reasoningTokens, record.costUsd, record.costSource);
    }
  }
}
