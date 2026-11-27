import type { AgentEngine } from "../../../engines";

export type BtwStatus = "running" | "completed" | "error" | "cancelled";

export interface BtwExchange {
  id: string;
  session_id: string;
  question: string;
  answer: string;
  status: BtwStatus;
  error: string | null;
  engine: AgentEngine;
  model: string | null;
  slot_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BtwEventDetail {
  sessionId?: string;
  action?: "upsert" | "delta" | "delete";
  exchange?: BtwExchange;
  id?: string;
  delta?: string;
}

const BTW_PREFIX = /^\s*\/btw(?:\s+([\s\S]*))?$/i;

export function parseBtwInput(content: string): { isBtw: boolean; question: string } {
  const match = BTW_PREFIX.exec(content);
  if (!match) return { isBtw: false, question: "" };
  return { isBtw: true, question: (match[1] ?? "").trim() };
}

export function applyBtwEvent(current: BtwExchange[], detail: BtwEventDetail): BtwExchange[] {
  if (detail.action === "delete" && detail.id) {
    return current.filter((item) => item.id !== detail.id);
  }
  if (detail.action === "delta" && detail.id && typeof detail.delta === "string") {
    let matched = false;
    const next = current.map((item) => {
      if (item.id !== detail.id) return item;
      matched = true;
      return { ...item, answer: item.answer + detail.delta };
    });
    return matched ? next : current;
  }
  if (detail.action === "upsert" && detail.exchange) {
    const incoming = detail.exchange;
    const index = current.findIndex((item) => item.id === incoming.id);
    if (index < 0) return [...current, incoming];
    const next = [...current];
    // Preserve any local streaming text if an earlier upsert arrives without the accumulated prefix.
    const existing = next[index];
    const answer = incoming.status === "running" && existing.answer.length > incoming.answer.length
      ? existing.answer
      : incoming.answer;
    next[index] = { ...incoming, answer };
    return next;
  }
  return current;
}
