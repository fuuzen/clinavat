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

/** Antigravity model aliases that share pricing with their underlying Gemini model. */
const modelAliases: Record<string, string> = {
  'gemini-pro-orchestrator': 'gemini-4-carbon',
  'gemini-pro-orchestrator-neon': 'gemini-4-neon',
  'gemini-pro-orchestrator-argon': 'gemini-4-argon',
  'gemini-pro-orchestrator-hydrogen': 'gemini-4-hydrogen',
};

/**
 * Names to look a model up by, keeping the normalized original name first so administrator overrides on it win:
 * Claude adds context (`[1m]`) or `-thinking` variants, dated snapshots share a price, and Antigravity aliases
 * map to their underlying Gemini models.
 */
export function priceKeys(model: string): string[] {
  const name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  const keys = [name];
  const add = (candidate: string | undefined) => {
    if (candidate && !keys.includes(candidate)) keys.push(candidate);
  };
  const unthinking = name.replace(/-thinking$/, '');
  add(unthinking);
  add(name.replace(/-\d{4}-?\d{2}-?\d{2}$/, ''));
  add(unthinking.replace(/-\d{4}-?\d{2}-?\d{2}$/, ''));
  for (const candidate of [...keys]) add(modelAliases[candidate]);
  return keys;
}

export function costOf(price: ModelPrice, counts: TokenCounts): number {
  const [input, cacheRead, cacheWrite, output] = price;
  return (counts.inputTokens * input + counts.cacheReadTokens * (cacheRead ?? input)
    + counts.cacheWriteTokens * (cacheWrite ?? input) + counts.outputTokens * output) / 1e6;
}

const perMillion = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Number((value * 1e6).toPrecision(12)) : null;

/** The OpenAI, Anthropic, and Google Gemini chat models of LiteLLM's `model_prices_and_context_window.json`. */
export function litellmPrices(document: unknown): Record<string, ModelPrice> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return {};
  const entries = Object.entries(document as Record<string, any>).sort(([left], [right]) => left.localeCompare(right));
  const prices: Record<string, ModelPrice> = {};
  for (const [name, model] of entries) {
    if (!model || typeof model !== 'object') continue;
    const provider = model.litellm_provider;
    let key: string | null = null;
    if (['openai', 'anthropic'].includes(provider) && ['chat', 'responses'].includes(model.mode)
      && /^(gpt-|o\d|claude-|codex)/.test(name) && !name.includes('/')) {
      key = name;
    } else if (provider === 'gemini' && model.mode === 'chat' && /^(?:gemini\/)?gemini-[^/]+$/.test(name)) {
      key = name.replace(/^gemini\//, '');
    }
    if (!key || key in prices) continue;
    const input = perMillion(model.input_cost_per_token), output = perMillion(model.output_cost_per_token);
    if (input === null || output === null) continue;
    prices[key] = [input, perMillion(model.cache_read_input_token_cost), perMillion(model.cache_creation_input_token_cost), output];
  }
  return Object.fromEntries(Object.entries(prices).sort(([left], [right]) => left.localeCompare(right)));
}
