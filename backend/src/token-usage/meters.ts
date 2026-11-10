import { estimateCost, type TokenCounts } from './prices.js';

export interface UsageRecord extends TokenCounts {
  model: string;
  costUsd: number | null;
  /** `cli` when the CLI estimated the cost itself, `prices` for the bundled price snapshot. */
  costSource: 'cli' | 'prices' | null;
}

export interface CodexTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

const codexFields = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const;

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const hasTokens = (counts: TokenCounts): boolean =>
  counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens + counts.outputTokens > 0;

function priced(model: string, counts: TokenCounts, cliCost?: unknown): UsageRecord {
  if (typeof cliCost === 'number' && Number.isFinite(cliCost) && cliCost >= 0) return { model, ...counts, costUsd: cliCost, costSource: 'cli' };
  const costUsd = estimateCost(model, counts);
  return { model, ...counts, costUsd, costSource: costUsd === null ? null : 'prices' };
}

/** Claude states every API call once, on the next result, keyed by model and with the CLI's own cost estimate. */
export class ClaudeUsageMeter {
  private messages = new Map<string, { model: string; usage: Record<string, unknown> }>();

  observeAssistant(event: any): void {
    const message = event?.message;
    if (typeof message?.id === 'string' && message.usage && typeof message.usage === 'object') {
      this.messages.set(message.id, { model: String(message.model || 'unknown'), usage: message.usage });
    }
  }

  finish(result: any): UsageRecord[] {
    const stated = result?.model_usage_since_last_result;
    const records = stated && typeof stated === 'object'
      ? Object.entries(stated as Record<string, any>).map(([model, usage]) => priced(model, {
        inputTokens: count(usage?.inputTokens), cacheReadTokens: count(usage?.cacheReadInputTokens),
        cacheWriteTokens: count(usage?.cacheCreationInputTokens), outputTokens: count(usage?.outputTokens), reasoningTokens: 0,
      }, usage?.costUSD))
      // A CLI without that internal field still reports each API message's usage; price those locally.
      : [...this.messages.values()].map(({ model, usage }) => priced(model, {
        inputTokens: count(usage.input_tokens), cacheReadTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens), outputTokens: count(usage.output_tokens), reasoningTokens: 0,
      }));
    this.messages.clear();
    return records.filter(hasTokens);
  }
}

export function codexTotals(value: unknown): CodexTotals | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(codexFields.map(field => [field, count(source[field])])) as unknown as CodexTotals;
}

/**
 * What one `thread/tokenUsage/updated` adds. Codex repeats unchanged thread totals, for instance with rate-limit
 * updates, so a conversation counts the growth past the total it last counted (`cursor`).
 */
export function codexUsage(model: string, total: CodexTotals, last: CodexTotals, cursor: CodexTotals | null): UsageRecord | null {
  // Without a cursor, or once the thread's totals restart, only the latest call is certainly new.
  const delta = cursor && total.totalTokens >= cursor.totalTokens
    ? Object.fromEntries(codexFields.map(field => [field, Math.max(0, total[field] - cursor[field])])) as unknown as CodexTotals
    : last;
  // OpenAI counts cached input inside the input total and reasoning inside the output total.
  const counts: TokenCounts = {
    inputTokens: Math.max(0, delta.inputTokens - delta.cachedInputTokens), cacheReadTokens: delta.cachedInputTokens,
    cacheWriteTokens: delta.cacheWriteInputTokens, outputTokens: delta.outputTokens, reasoningTokens: delta.reasoningOutputTokens,
  };
  return hasTokens(counts) ? priced(model, counts) : null;
}
