import type { Store } from '../database.js';
import { codexTotals, codexUsage, type UsageRecord } from './meters.js';
import type { PriceBook } from './price-book.js';
import { costOf, type TokenCounts } from './prices.js';
import type { AgentEngine } from '../agent/engines.js';

export interface UsageOwner { userId: string; slotId: string; sessionId: string; turnId: string | null; engine: AgentEngine }

export type TokenUsageUpdate = { records: UsageRecord[] } | { codex: { model: string; tokenUsage: unknown } };

export interface UsageRow {
  user_id: string; username: string | null; slot_id: string; slot_label: string | null;
  engine: AgentEngine; model: string;
  input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; output_tokens: number; reasoning_tokens: number;
  cost_usd: number | null;
  /** Records whose model has neither a CLI estimate nor a price, so `cost_usd` leaves them out. */
  unpriced: number;
  last_used_at: string;
}

interface ReportRow extends Omit<UsageRow, 'cost_usd' | 'unpriced'> {
  cli_cost: number | null;
  /** Records without a CLI estimate, and their tokens, which the price book prices. */
  estimated: number; estimated_input: number; estimated_cache_read: number; estimated_cache_write: number; estimated_output: number;
}

const counts = (input: number, cacheRead: number, cacheWrite: number, output: number): TokenCounts =>
  ({ inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output, reasoningTokens: 0 });

/** Token use of every turn, kept per user and slot; rows outlive the conversations they came from. */
export class TokenUsageLedger {
  constructor(private store: Store, private prices: PriceBook) {}

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
    const estimated = (column: string) => `SUM(CASE WHEN t.cost_source='cli' THEN 0 ELSE t.${column} END)`;
    return this.store.all<ReportRow>(`SELECT t.user_id,u.username,t.slot_id,s.label AS slot_label,t.engine,t.model,
        SUM(t.input_tokens) AS input_tokens,SUM(t.cache_read_tokens) AS cache_read_tokens,
        SUM(t.cache_write_tokens) AS cache_write_tokens,SUM(t.output_tokens) AS output_tokens,
        SUM(t.reasoning_tokens) AS reasoning_tokens,SUM(CASE WHEN t.cost_source='cli' THEN t.cost_usd END) AS cli_cost,
        SUM(t.cost_source IS NOT 'cli') AS estimated,${estimated('input_tokens')} AS estimated_input,
        ${estimated('cache_read_tokens')} AS estimated_cache_read,${estimated('cache_write_tokens')} AS estimated_cache_write,
        ${estimated('output_tokens')} AS estimated_output,MAX(t.recorded_at) AS last_used_at
      FROM token_usage t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN account_slots s ON s.id=t.slot_id
      WHERE (?1 IS NULL OR t.user_id=?1) AND (?2 IS NULL OR t.recorded_at>=?2)
      GROUP BY t.user_id,t.slot_id,t.engine,t.model ORDER BY u.username,t.slot_id,t.model`, userId ?? null, since)
      .map(({ cli_cost, estimated, estimated_input, estimated_cache_read, estimated_cache_write, estimated_output, ...row }) => {
        const found = this.prices.find(row.model);
        // An administrator's correction prices every record of the model, including those the CLI estimated.
        if (found?.custom) {
          return { ...row, unpriced: 0, cost_usd: costOf(found.price,
            counts(row.input_tokens, row.cache_read_tokens, row.cache_write_tokens, row.output_tokens)) };
        }
        const estimate = !estimated ? 0 : found
          ? costOf(found.price, counts(estimated_input, estimated_cache_read, estimated_cache_write, estimated_output)) : null;
        return { ...row, unpriced: estimate === null ? estimated : 0,
          cost_usd: cli_cost === null && estimate === null ? null : (cli_cost ?? 0) + (estimate ?? 0) };
      });
  }

  /** Models used without a CLI estimate that no price covers, so that an administrator can add their prices. */
  unpricedModels(): string[] {
    return this.store.all<{ model: string }>("SELECT DISTINCT model FROM token_usage WHERE cost_source IS NOT 'cli' ORDER BY model")
      .map(row => row.model).filter(model => !this.prices.find(model));
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
