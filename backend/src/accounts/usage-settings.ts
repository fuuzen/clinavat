import { z } from 'zod';
import type { Store } from '../database.js';

const duration = z.number().int().min(15 * 60_000, '不能少于 15 分钟').max(7 * 24 * 3_600_000, '不能超过 7 天');
export const usageSettingsSchema = z.object({ refreshIntervalMs: duration, staleAfterMs: duration }).strict();
export type UsageSettings = z.infer<typeof usageSettingsSchema>;

const defaults: UsageSettings = { refreshIntervalMs: 12 * 3_600_000, staleAfterMs: 12 * 3_600_000 };

/**
 * How often idle slots are queried and how long a reading counts as current. Live readings pushed by
 * running conversations are taken whenever they arrive.
 */
export class UsageSettingsStore {
  private cached?: UsageSettings;

  constructor(private readonly store: Store) {}

  view(): UsageSettings {
    if (this.cached) return this.cached;
    const row = this.store.get<{ refresh_interval_ms: number; stale_after_ms: number }>(
      'SELECT refresh_interval_ms,stale_after_ms FROM usage_settings WHERE id=1');
    this.cached = row ? { refreshIntervalMs: row.refresh_interval_ms, staleAfterMs: row.stale_after_ms } : defaults;
    return this.cached;
  }

  update(settings: UsageSettings): UsageSettings {
    this.store.run(`INSERT INTO usage_settings(id,refresh_interval_ms,stale_after_ms) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET refresh_interval_ms=excluded.refresh_interval_ms,stale_after_ms=excluded.stale_after_ms`,
    settings.refreshIntervalMs, settings.staleAfterMs);
    this.cached = undefined;
    return this.view();
  }
}
