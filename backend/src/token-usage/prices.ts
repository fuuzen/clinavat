export interface TokenCounts {
  /** Input that was neither read from nor written to the prompt cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes reasoning, which providers bill as output. */
  outputTokens: number;
  reasoningTokens: number;
}

/** USD per million tokens: input, cache read, cache write, output. A missing cache price falls back to input. */
export type ModelPrice = readonly [number, number | null, number | null, number];

/** Names to look a model up by: Claude adds a context variant (`claude-opus-5-5[1m]`), dated snapshots share a price. */
export function priceKeys(model: string): string[] {
  const name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  const undated = name.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
  return undated === name ? [name] : [name, undated];
}

export function costOf(price: ModelPrice, counts: TokenCounts): number {
  const [input, cacheRead, cacheWrite, output] = price;
  return (counts.inputTokens * input + counts.cacheReadTokens * (cacheRead ?? input)
    + counts.cacheWriteTokens * (cacheWrite ?? input) + counts.outputTokens * output) / 1e6;
}

const perMillion = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Number((value * 1e6).toPrecision(12)) : null;

/** The OpenAI and Anthropic chat models of LiteLLM's `model_prices_and_context_window.json`. */
export function litellmPrices(document: unknown): Record<string, ModelPrice> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return {};
  const prices: Record<string, ModelPrice> = {};
  for (const [name, model] of Object.entries(document as Record<string, any>).sort(([left], [right]) => left.localeCompare(right))) {
    if (!model || typeof model !== 'object' || !['openai', 'anthropic'].includes(model.litellm_provider)
      || !['chat', 'responses'].includes(model.mode) || !/^(gpt-|o\d|claude-|codex)/.test(name) || name.includes('/')) continue;
    const input = perMillion(model.input_cost_per_token), output = perMillion(model.output_cost_per_token);
    if (input === null || output === null) continue;
    prices[name] = [input, perMillion(model.cache_read_input_token_cost), perMillion(model.cache_creation_input_token_cost), output];
  }
  return prices;
}
