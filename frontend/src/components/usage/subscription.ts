import type { Slot, SlotLogin, SlotSubscription, SlotUsage } from "../../types";
import type { AgentEngine } from "../../engines";

const codexPlans: Record<string, string> = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", promax: "Pro Max", team: "Team",
  business: "Business", enterprise: "Enterprise", edu: "Edu",
};

const titleCase = (value: string) => value.split(/[_\s-]+/).filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** How each CLI names the plan its login files state. */
const planLabels: Record<AgentEngine, (plan: string, tier: string | null) => string> = {
  claude(plan, tier) {
    // Claude's tier names the Max multiplier, such as `default_claude_max_20x`.
    const multiplier = tier?.match(/_(\d+x)$/)?.[1];
    return `${titleCase(plan)}${multiplier ? ` ${multiplier}` : ""}`;
  },
  codex: (plan) => codexPlans[plan] ?? titleCase(plan),
};

export function subscriptionLabel(engine: Slot["engine"], subscription: SlotSubscription | null): string | null {
  return subscription?.plan ? planLabels[engine](subscription.plan, subscription.tier) : null;
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

const moment = (timestamp: string) => new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function loginStatus(login: SlotLogin | null, now: number): SubscriptionStatus | null {
  if (!login) return null;
  if (login.method === "none") return { text: "尚未登录", level: "critical" };
  if (login.method === "apikey") return { text: "API key 登录，无到期时间", level: "" };
  if (login.method === "token") {
    if (!login.expiresAt) return { text: "长期令牌 · 到期时间未记录", level: "" };
    const days = Math.ceil((Date.parse(login.expiresAt) - now) / DAY);
    return days <= 0 ? { text: `长期令牌已于 ${day(login.expiresAt)} 到期，请重新生成`, level: "critical" }
      : { text: `长期令牌 ${day(login.expiresAt)} 到期 · 剩余 ${days} 天`, level: days <= 30 ? "warning" : "" };
  }
  const parts = ["浏览器登录，无固定到期时间"];
  if (login.accessExpiresAt) parts.push(Date.parse(login.accessExpiresAt) > now
    ? `访问令牌有效至 ${moment(login.accessExpiresAt)}` : "访问令牌已过期，下次使用时由 CLI 续期");
  if (login.refreshedAt) parts.push(`上次续期 ${moment(login.refreshedAt)}`);
  return { text: parts.join(" · "), level: "" };
}
