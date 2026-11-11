import type { Slot, SlotSubscription, SlotUsage } from "../../types";

const codexPlans: Record<string, string> = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", promax: "Pro Max", team: "Team",
  business: "Business", enterprise: "Enterprise", edu: "Edu",
};

const titleCase = (value: string) => value.split(/[_\s-]+/).filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export function subscriptionLabel(engine: Slot["engine"], subscription: SlotSubscription | null): string | null {
  if (!subscription?.plan) return null;
  if (engine === "codex") return codexPlans[subscription.plan] ?? titleCase(subscription.plan);
  // Claude's tier names the Max multiplier, such as `default_claude_max_20x`.
  const multiplier = subscription.tier?.match(/_(\d+x)$/)?.[1];
  return `${titleCase(subscription.plan)}${multiplier ? ` ${multiplier}` : ""}`;
}

/** The plan from the login files, or else the plan the last quota reading named. */
export function planName(engine: Slot["engine"], usage: SlotUsage | undefined): string | null {
  return subscriptionLabel(engine, usage?.subscription ?? null) ?? (usage?.plan ? titleCase(usage.plan) : null);
}

const day = (timestamp: string) => new Date(timestamp).toLocaleDateString("zh-CN");
const DAY = 86_400_000;

export interface SubscriptionStatus { text: string; level: "" | "warning" | "critical" }

export function subscriptionStatus(subscription: SlotSubscription | null, now: number): SubscriptionStatus | null {
  if (!subscription) return null;
  if (subscription.expiresAt) {
    const remaining = Date.parse(subscription.expiresAt) - now;
    if (remaining <= 0) return { text: `订阅已于 ${day(subscription.expiresAt)} 到期`, level: "critical" };
    const days = Math.ceil(remaining / DAY);
    return { text: `${day(subscription.expiresAt)} 到期 · 剩余 ${days} 天`, level: days <= 7 ? "warning" : "" };
  }
  return subscription.startedAt ? { text: `订阅始于 ${day(subscription.startedAt)} · 未提供到期日`, level: "" } : null;
}
