import type { TokenUsageReport, TokenUsageRow } from "../src/types";
import { db } from "./store";

const models = { claude: ["claude-opus-5-5", "claude-haiku-5-5"], codex: ["gpt-6-sol"], antigravity: ["gemini-3.8-flash"] };

// Deterministic sample figures, scaled by the requested period so the period selector visibly changes them.
export function tokenUsageReport(days: number, userId?: string): TokenUsageReport {
  const scale = days ? Math.min(days, 90) / 30 : 4;
  const users = db.users.filter((user) => !userId || user.id === userId);
  const rows = users.flatMap((user, userIndex) => db.slots.flatMap((slot, slotIndex) =>
    models[slot.engine].map((model, modelIndex): TokenUsageRow => {
      const base = Math.round((180_000 + 90_000 * slotIndex) * scale / (1 + userIndex + modelIndex * 3));
      const cost = slot.engine === "claude" ? base * (modelIndex ? 0.0000012 : 0.000011) : null;
      return {
        user_id: user.id, username: user.username, slot_id: slot.id, slot_label: slot.label, engine: slot.engine, model,
        input_tokens: Math.round(base * 0.18), cache_read_tokens: Math.round(base * 0.7), cache_write_tokens: Math.round(base * 0.06),
        output_tokens: Math.round(base * 0.06), reasoning_tokens: slot.engine === "codex" ? Math.round(base * 0.02) : 0,
        cost_usd: cost ?? base * 0.0000035, unpriced: 0,
        last_used_at: new Date(Date.now() - (slotIndex + 1) * 3_600_000).toISOString().replace("T", " ").slice(0, 19),
      };
    })));
  return { days, priceSnapshotDate: "2026-11-10", rows };
}
