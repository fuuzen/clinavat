import { modelPrices } from './model-prices.js';

export interface TokenCounts {
  /** Input that was neither read from nor written to the prompt cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes reasoning, which providers bill as output. */
  outputTokens: number;
  reasoningTokens: number;
}

function pricesFor(model: string) {
  // Claude names a context variant in brackets (`claude-opus-5-5[1m]`); dated snapshots share their model's price.
  const name = model.toLowerCase().replace(/\[[^\]]*\]$/, '');
  return modelPrices[name] ?? modelPrices[name.replace(/-\d{4}-?\d{2}-?\d{2}$/, '')];
}

/** API list price of the counted tokens, or null for a model missing from the bundled snapshot. */
export function estimateCost(model: string, counts: TokenCounts): number | null {
  const prices = pricesFor(model);
  if (!prices) return null;
  const [input, cacheRead, cacheWrite, output] = prices;
  return (counts.inputTokens * input + counts.cacheReadTokens * (cacheRead ?? input)
    + counts.cacheWriteTokens * (cacheWrite ?? input) + counts.outputTokens * output) / 1e6;
}
