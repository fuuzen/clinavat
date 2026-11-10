import type { TokenUsageRow } from "../../types";

export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  cost: number;
  unpriced: number;
  lastUsedAt: string;
}

export const usagePeriods = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
  { days: 0, label: "全部" },
];

export function sumUsage(rows: TokenUsageRow[]): UsageTotals {
  return rows.reduce<UsageTotals>((sum, row) => {
    const input = row.input_tokens + sum.input;
    const cacheRead = row.cache_read_tokens + sum.cacheRead;
    const cacheWrite = row.cache_write_tokens + sum.cacheWrite;
    const output = row.output_tokens + sum.output;
    return {
      input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output,
      cost: sum.cost + (row.cost_usd ?? 0), unpriced: sum.unpriced + row.unpriced,
      lastUsedAt: row.last_used_at > sum.lastUsedAt ? row.last_used_at : sum.lastUsedAt,
    };
  }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: 0, unpriced: 0, lastUsedAt: "" });
}

export const engineLabel = (engine: TokenUsageRow["engine"]) => engine === "claude" ? "Claude Code" : "Codex";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(value: number): string {
  return value < 10_000 ? value.toLocaleString("en-US") : compact.format(value);
}

/** A trailing plus marks totals that leave out records of models without a known price. */
export function formatCost(totals: Pick<UsageTotals, "cost" | "unpriced" | "total">): string {
  if (totals.unpriced && !totals.cost) return "—";
  const amount = `$${totals.cost.toFixed(totals.cost && totals.cost < 1 ? 4 : 2)}`;
  return totals.unpriced ? `${amount}+` : amount;
}

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS".
export function formatUsedAt(timestamp: string): string {
  if (!timestamp) return "—";
  return new Date(`${timestamp.replace(" ", "T")}Z`).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
