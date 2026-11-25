import type { Store } from '../database.js';
import { HttpError } from '../models.js';
import { modelPrices, priceSnapshotDate } from './model-prices.js';
import { litellmPrices, priceKeys, type ModelPrice } from './prices.js';

export interface PriceSnapshotInfo {
  source: 'bundled' | 'imported';
  /** The bundled snapshot's date, or the day an administrator imported one. */
  date: string;
  models: number;
}

export interface PriceEntry { model: string; price: ModelPrice; snapshot: ModelPrice | null; custom: boolean }

interface OverrideRow { model: string; input: number; cache_read: number | null; cache_write: number | null; output: number }

/**
 * Prices for estimating costs: the bundled LiteLLM snapshot, or one an administrator imported in its place, with
 * the administrator's corrections on top. Reports read prices when they are produced, so changes apply to past usage.
 */
export class PriceBook {
  private snapshot: Record<string, ModelPrice> = modelPrices;
  private overrides = new Map<string, ModelPrice>();
  private snapshotInfo: PriceSnapshotInfo = { source: 'bundled', date: priceSnapshotDate, models: Object.keys(modelPrices).length };

  constructor(private store: Store) { this.load(); }

  info(): PriceSnapshotInfo { return this.snapshotInfo; }

  find(model: string): { price: ModelPrice; custom: boolean } | undefined {
    const keys = priceKeys(model);
    for (const key of keys) {
      const custom = this.overrides.get(key);
      if (custom) return { price: custom, custom: true };
    }
    for (const key of keys) if (this.snapshot[key]) return { price: this.snapshot[key], custom: false };
    return undefined;
  }

  entries(): PriceEntry[] {
    const models = new Set([...Object.keys(this.snapshot), ...this.overrides.keys()]);
    return [...models].sort().map(model => ({ model, price: this.overrides.get(model) ?? this.snapshot[model],
      snapshot: this.snapshot[model] ?? null, custom: this.overrides.has(model) }));
  }

  importLiteLLM(document: unknown): PriceSnapshotInfo {
    const prices = litellmPrices(document);
    if (!Object.keys(prices).length) throw new HttpError(400, '文件中没有 OpenAI、Anthropic 或 Google Gemini 模型的价格，请上传 LiteLLM 的 model_prices_and_context_window.json');
    this.store.run(`INSERT INTO model_price_snapshot(id,prices,imported_at) VALUES(1,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET prices=excluded.prices,imported_at=excluded.imported_at`, JSON.stringify(prices));
    this.load();
    return this.snapshotInfo;
  }

  restoreBundled(): PriceSnapshotInfo {
    this.store.run('DELETE FROM model_price_snapshot');
    this.load();
    return this.snapshotInfo;
  }

  /** A correction for one model, which also replaces the cost the Claude CLI estimated itself; null removes it. */
  setOverride(model: string, price: ModelPrice | null): void {
    const key = priceKeys(model)[0];
    if (!key) throw new HttpError(400, '请填写模型名称');
    if (price) {
      this.store.run(`INSERT INTO model_price_overrides(model,input,cache_read,cache_write,output) VALUES(?,?,?,?,?)
        ON CONFLICT(model) DO UPDATE SET input=excluded.input,cache_read=excluded.cache_read,cache_write=excluded.cache_write,
          output=excluded.output,updated_at=datetime('now')`, key, ...price);
    } else this.store.run('DELETE FROM model_price_overrides WHERE model=?', key);
    this.load();
  }

  private load(): void {
    const imported = this.store.get<{ prices: string; imported_at: string }>('SELECT prices,imported_at FROM model_price_snapshot WHERE id=1');
    this.snapshot = imported ? JSON.parse(imported.prices) as Record<string, ModelPrice> : modelPrices;
    this.snapshotInfo = { source: imported ? 'imported' : 'bundled', date: imported ? imported.imported_at.slice(0, 10) : priceSnapshotDate,
      models: Object.keys(this.snapshot).length };
    this.overrides = new Map(this.store.all<OverrideRow>('SELECT model,input,cache_read,cache_write,output FROM model_price_overrides')
      .map(row => [row.model, [row.input, row.cache_read, row.cache_write, row.output] as const]));
  }
}
