import type { SlotUsage, UsageWindow } from "../../types";
import type { AgentEngine } from "../../engines";

export interface UsageRing {
  /** Outer: the account's main allowance; inner: the 5-hour window; core: a per-model weekly window such as Fable. */
  position: "outer" | "inner" | "core";
  used: number | null;
  /** The last reading, kept on screen although it is out of date. */
  stale: boolean;
  level: "normal" | "warning" | "critical";
  description: string;
}

interface AccountWindows { main?: UsageWindow; fiveHour?: UsageWindow; model?: UsageWindow }

/** Which of each CLI's quota windows the rings draw. */
const windowLayouts: Record<AgentEngine, (windows: UsageWindow[]) => AccountWindows> = {
  claude(windows) {
    // Per-model weekly windows, such as Fable's, have their own allowance; the busiest one is drawn.
    const model = windows.filter((window) => window.key.startsWith("model:"))
      .sort((left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1))[0];
    return {
      main: windows.find((window) => window.key === "seven_day"),
      fiveHour: windows.find((window) => window.key === "five_hour"),
      model,
    };
  },
  codex(windows) {
    // Model-specific Codex buckets are not the account's total allowance.
    const account = windows.filter((window) => /^codex:(primary|secondary)$/.test(window.key));
    const fiveHour = account.find((window) => window.windowMinutes === 300);
    const remaining = account.filter((window) => window !== fiveHour && window.windowMinutes !== 300);
    return {
      main: remaining.find((window) => window.windowMinutes === 10080)
        || remaining.find((window) => window.key === "codex:primary") || remaining[0],
      fiveHour,
    };
  },
  antigravity(windows) {
    // Each model group has its own weekly and 5-hour windows: Gemini's are the main ones, the busiest other group the core.
    const group = (window: UsageWindow) => window.key.replace(/-[^-]+$/, "");
    const weekly = windows.filter((window) => window.windowMinutes === 10080);
    const main = weekly.find((window) => window.key.startsWith("gemini")) ?? weekly[0];
    return {
      main,
      fiveHour: windows.find((window) => window.windowMinutes === 300 && main && group(window) === group(main)),
      model: weekly.filter((window) => window !== main).sort((left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1))[0],
    };
  },
};

export function accountWindows(engine: AgentEngine, windows: UsageWindow[]): AccountWindows {
  return windowLayouts[engine](windows);
}

/** Why no usage can be drawn at all; a stale snapshot is still drawn, dimmed. */
function unavailableReason(usage: SlotUsage | undefined): string | null {
  if (!usage) return "额度尚未获取";
  if (usage.state === "unavailable") return usage.error || "账号未提供额度窗口";
  if (usage.state === "pending") return usage.refreshing ? "正在查询额度" : "额度尚未获取";
  if (usage.state === "error") return usage.error ? `额度查询失败：${usage.error}` : "额度查询失败";
  if (!Number.isFinite(usage.observedAt ? Date.parse(usage.observedAt) : NaN)) return "额度更新时间未知";
  return null;
}

function staleReason(usage: SlotUsage | undefined, now: number): string | null {
  if (usage?.state !== "ok") return null;
  if (usage.error) return `额度查询失败，显示上次数据：${usage.error}`;
  // The backend marks staleness when asked; between polls the expiry it sent decides.
  const expires = usage.expiresAt ? Date.parse(usage.expiresAt) : NaN;
  if (usage.stale || now > expires) return "额度数据已过期，显示上次数据";
  return null;
}

function ring(window: UsageWindow, position: UsageRing["position"], circle: string, reason: string | null,
  staleness: string | null, now: number): UsageRing {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  // Past its reset the old share no longer applies; the window is drawn empty and dimmed until a new reading.
  const resetPassed = !reason && reset <= now;
  const percent = window.usedPercent;
  const known = !reason && percent !== null && Number.isFinite(percent) && percent >= 0;
  const used = resetPassed ? 0 : known ? percent : null;
  const period = position === "inner" ? "5 小时" : position === "core" ? window.label
    : window.windowMinutes === 10080 ? "每周总额度" : `主额度（${window.label}）`;
  const state = reason || (resetPassed ? "已到重置时间，待刷新确认" : used === null ? "已用比例未知" : `已用 ${used}%`);
  return {
    position,
    used,
    stale: used !== null && (resetPassed || !!staleness),
    level: window.limited || (!resetPassed && used !== null && used >= 90) ? "critical"
      : !resetPassed && used !== null && used >= 70 ? "warning" : "normal",
    description: `${circle} ${period}：${state}${window.limited ? "，服务端报告此窗口受限" : ""}`,
  };
}

export function slotUsageRings(engine: AgentEngine, usage: SlotUsage | undefined, now: number, slotLimited = false) {
  const { main, fiveHour, model } = accountWindows(engine, usage?.windows || []);
  const reason = unavailableReason(usage);
  const staleness = reason ? null : staleReason(usage, now);
  const rings: UsageRing[] = [];
  if (main) rings.push(ring(main, "outer", "外圈", reason, staleness, now));
  if (fiveHour) rings.push(ring(fiveHour, "inner", model ? "中圈" : "内圈", reason, staleness, now));
  if (model) rings.push(ring(model, "core", "内圈", reason, staleness, now));
  if (!rings.length) rings.push({
    position: "outer", used: null, stale: false, level: "normal",
    description: reason || "未返回账号总额度窗口，其他额度请查看菜单",
  });
  const limited = slotLimited || usage?.limited === true || usage?.windows.some((window) => window.limited === true) || false;
  const descriptions = rings.map((item) => item.description);
  if (!main && fiveHour) descriptions.push("未提供主额度窗口");
  if (staleness && rings.some((item) => item.used !== null)) descriptions.push(staleness);
  if (limited) descriptions.push("服务端报告额度受限");
  if (usage?.refreshing && usage.state === "ok") descriptions.push("正在刷新");
  return { rings, limited, description: descriptions.join("；") };
}
