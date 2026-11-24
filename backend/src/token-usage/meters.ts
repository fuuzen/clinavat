import type { TokenCounts } from './prices.js';

export interface UsageRecord extends TokenCounts {
  model: string;
  /** The CLI's own estimate; without one, reports price the tokens with the current price book. */
  costUsd: number | null;
  costSource: 'cli' | null;
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
  const stated = typeof cliCost === 'number' && Number.isFinite(cliCost) && cliCost >= 0;
  return { model, ...counts, costUsd: stated ? cliCost : null, costSource: stated ? 'cli' : null };
}

/** Claude states every API call once, on the next result, keyed by model and with the CLI's own cost estimate. */
export class ClaudeUsageMeter {
  private messages = new Map<string, { model: string; usage: Record<string, unknown> }>();
  private lastContextTokens = 0;

  observeAssistant(event: any): void {
    const message = event?.message;
    const usage = message?.usage;
    if (!usage || typeof usage !== 'object') return;
    if (typeof message.id === 'string') this.messages.set(message.id, { model: String(message.model || 'unknown'), usage });
    if (!event.parent_tool_use_id && !event.agent_id) {
      this.lastContextTokens = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    }
  }

  finish(result: any): { records: UsageRecord[]; contextTokens: number } {
    const stated = result?.model_usage_since_last_result;
    const records = stated && typeof stated === 'object'
      ? Object.entries(stated as Record<string, any>).map(([model, usage]) => priced(model, {
        inputTokens: count(usage?.inputTokens), cacheReadTokens: count(usage?.cacheReadInputTokens),
        cacheWriteTokens: count(usage?.cacheCreationInputTokens), outputTokens: count(usage?.outputTokens), reasoningTokens: 0,
      }, usage?.costUSD))
      // A CLI without that internal field still reports each API message's usage; reports price those.
      : [...this.messages.values()].map(({ model, usage }) => priced(model, {
        inputTokens: count(usage.input_tokens), cacheReadTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens), outputTokens: count(usage.output_tokens), reasoningTokens: 0,
      }));
    this.messages.clear();
    const contextTokens = this.lastContextTokens;
    this.lastContextTokens = 0;
    return { records: records.filter(hasTokens), contextTokens };
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

/** agy states each prompt's tokens in its ACP prompt response; input excludes cache reads, output includes thinking. */
export function antigravityUsage(model: string, usage: any): UsageRecord | null {
  const counts: TokenCounts = { inputTokens: count(usage?.inputTokens), cacheReadTokens: count(usage?.cachedReadTokens),
    cacheWriteTokens: count(usage?.cachedWriteTokens), outputTokens: count(usage?.outputTokens), reasoningTokens: count(usage?.thoughtTokens) };
  return hasTokens(counts) ? priced(model, counts) : null;
}

/** ACP reports aggregate input for a prompt. A batch of parallel calls belongs to one model response. */
export class AntigravityPromptRounds {
  private rounds = 1;
  private phase: 'output' | 'tools' | 'results' = 'output';
  private activeTools = new Set<string>();

  observe(kind: string, callId?: string, status?: string): void {
    const finished = status === 'completed' || status === 'failed';
    if (kind === 'tool_call' && callId) {
      if (this.phase === 'results') this.rounds++;
      this.phase = 'tools';
      if (!finished) this.activeTools.add(callId);
    } else if (kind === 'tool_call_update' && finished && callId && this.activeTools.delete(callId) && !this.activeTools.size) {
      this.phase = 'results';
    } else if (this.phase !== 'output' && (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')) {
      this.rounds++;
      this.phase = 'output';
      this.activeTools.clear();
    }
  }

  estimate(record: UsageRecord): number {
    return Math.round((record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens) / this.rounds);
  }
}
