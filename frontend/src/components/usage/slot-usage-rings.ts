import type { SlotUsage, UsageWindow } from "../../types";

export interface UsageRing {
  position: "outer" | "inner";
  used: number | null;
  level: "normal" | "warning" | "critical";
  description: string;
}

const STALE_AFTER = 15 * 60_000;

function accountWindows(engine: "claude" | "codex", windows: UsageWindow[]) {
  if (engine === "claude") {
    return {
      main: windows.find((window) => window.key === "seven_day"),
      fiveHour: windows.find((window) => window.key === "five_hour"),
    };
  }
  // Model-specific Codex buckets are not the account's total allowance.
  const account = windows.filter((window) => /^codex:(primary|secondary)$/.test(window.key));
  const fiveHour = account.find((window) => window.windowMinutes === 300);
  const remaining = account.filter((window) => window !== fiveHour && window.windowMinutes !== 300);
  return {
    main: remaining.find((window) => window.windowMinutes === 10080)
      || remaining.find((window) => window.key === "codex:primary") || remaining[0],
    fiveHour,
  };
}

function unavailableReason(usage: SlotUsage | undefined, now: number): string | null {
  if (!usage) return "额度尚未获取";
  if (usage.state === "unavailable") return usage.error || "账号未提供额度窗口";
  if (usage.error) return `额度查询失败：${usage.error}`;
  if (usage.state === "pending") return usage.refreshing ? "正在查询额度" : "额度尚未获取";
  if (usage.state === "error") return "额度查询失败";
  const observed = usage.observedAt ? Date.parse(usage.observedAt) : NaN;
  if (!Number.isFinite(observed)) return "额度更新时间未知";
  if (usage.stale || now - observed > STALE_AFTER) return "额度数据已过期，待刷新";
  return null;
}

function ring(window: UsageWindow, position: UsageRing["position"], reason: string | null, now: number): UsageRing {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const unknown = reason || (reset <= now ? "已到重置时间，待刷新确认" : null);
  const percent = window.usedPercent;
  const used = unknown || percent === null || !Number.isFinite(percent) || percent < 0 ? null : percent;
  const period = position === "inner" ? "5 小时" : window.windowMinutes === 10080 ? "每周总额度" : `主额度（${window.label}）`;
  return {
    position,
    used,
    level: window.limited || (used !== null && used >= 90) ? "critical" : used !== null && used >= 70 ? "warning" : "normal",
    description: `${position === "outer" ? "外圈" : "内圈"} ${period}：${used === null ? unknown || "已用比例未知" : `已用 ${used}%`}${window.limited ? "，服务端报告此窗口受限" : ""}`,
  };
}

export function slotUsageRings(engine: "claude" | "codex", usage: SlotUsage | undefined, now: number, slotLimited = false) {
  const { main, fiveHour } = accountWindows(engine, usage?.windows || []);
  const reason = unavailableReason(usage, now);
  const rings: UsageRing[] = [];
  if (main) rings.push(ring(main, "outer", reason, now));
  if (fiveHour) rings.push(ring(fiveHour, "inner", reason, now));
  if (!rings.length) rings.push({
    position: "outer", used: null, level: "normal",
    description: reason || "未返回账号总额度窗口，其他额度请查看菜单",
  });
  const limited = slotLimited || usage?.limited === true || usage?.windows.some((window) => window.limited === true) || false;
  const descriptions = rings.map((item) => item.description);
  if (!main && fiveHour) descriptions.push("未提供主额度窗口");
  if (limited) descriptions.push("服务端报告额度受限");
  if (usage?.refreshing && usage.state === "ok") descriptions.push("正在刷新");
  return { rings, limited, description: descriptions.join("；") };
}
