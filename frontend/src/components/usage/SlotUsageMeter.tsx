import { LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { errorText } from "../../api";
import type { SlotUsage, UsageWindow } from "../../types";
import { refreshSlotUsage, useNow } from "../../useSlotUsage";

interface Props {
  slotId: string;
  usage?: SlotUsage;
  compact?: boolean;
  refreshable?: boolean;
  refreshRole?: "menuitem";
  refreshLabel?: string;
}

function duration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days} 天${hours ? ` ${hours} 小时` : ""}`;
  if (hours) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `${minutes} 分钟`;
}

function ago(timestamp: string | null, now: number): string {
  if (!timestamp) return "未知";
  const elapsed = now - Date.parse(timestamp);
  return elapsed < 60_000 ? "刚刚" : `${duration(elapsed)}前`;
}

// A reset time in the past does not prove recovery; only a fresh observation does.
function resetText(window: UsageWindow, now: number): string {
  if (!window.resetsAt) return "重置时间未知";
  const remaining = Date.parse(window.resetsAt) - now;
  return remaining > 0 ? `${duration(remaining)}后重置` : "已到重置时间，待刷新确认";
}

function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function statusText(usage: SlotUsage | undefined, now: number): string {
  if (!usage || (usage.state === "pending" && !usage.refreshing)) return "尚未查询额度";
  if (usage.state === "pending") return "正在查询额度…";
  if (usage.state === "error") return `额度查询失败：${usage.error || "未知错误"}`;
  if (usage.state === "unavailable") return usage.error || "该账号没有额度窗口数据";
  const parts = [`更新于 ${ago(usage.observedAt, now)}`];
  if (usage.source === "event") parts.push("来自对话");
  return parts.join(" · ");
}

export default function SlotUsageMeter({ slotId, usage, compact = false, refreshable = false,
  refreshRole, refreshLabel = "刷新额度" }: Props) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const windows = usage?.state === "ok" ? usage.windows : [];
  const refreshError = error || (usage?.state === "ok" && usage.stale ? usage.error : null);
  async function refresh() {
    if (busy || usage?.refreshing) return;
    setBusy(true);
    setError("");
    try {
      await refreshSlotUsage(slotId);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className={`usage-meter${compact ? " compact" : ""}${usage?.stale ? " stale" : ""}`}>
      {!compact && (
        <span className="usage-meter-heading">
          <span>额度</span>
          {planLabel(usage?.plan ?? null) && <small>{planLabel(usage?.plan ?? null)}</small>}
          {usage?.limited && <span className="badge badge-amber">服务端报告额度受限</span>}
          {usage?.stale && <span className="badge">数据已过期</span>}
        </span>
      )}
      {windows.map((window) => {
        const used = window.usedPercent;
        const remaining = used === null ? null : Math.max(0, 100 - used);
        const level = used === null ? "" : used >= 90 || window.limited ? "critical" : used >= 70 ? "warning" : "";
        return (
          <span className="usage-window" key={window.key}>
            <span className="usage-window-copy">
              <span>{window.label}</span>
              <span>
                {used === null ? "已用未知" : compact ? `剩余 ${remaining}%` : `已用 ${used}% · 剩余 ${remaining}%`}
              </span>
            </span>
            <span className={`usage-bar ${level}`} aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.max(0, used ?? 0))}%` }} />
            </span>
            <small>{resetText(window, now)}</small>
          </span>
        );
      })}
      {usage?.state === "ok" && !windows.length && <small>服务端未返回额度窗口</small>}
      {!compact && usage?.credits && (
        <small>
          积分余额：{usage.credits.unlimited ? "不限" : usage.credits.balance === null ? "未知"
            : Number(usage.credits.balance).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
        </small>
      )}
      <span className="usage-meter-status">
        <small className={usage?.state === "error" || usage?.stale ? "usage-warning" : ""}>
          {compact && usage?.stale ? "数据已过期 · " : ""}
          {compact && usage?.limited ? "服务端报告额度受限 · " : ""}
          {statusText(usage, now)}
          {usage?.state === "ok" && usage.refreshing ? " · 刷新中" : ""}
        </small>
        {refreshable && (
          <button type="button" className="icon-button" disabled={busy || usage?.refreshing}
            role={refreshRole} tabIndex={refreshRole ? -1 : undefined} aria-busy={busy || usage?.refreshing || false}
            onClick={() => void refresh()} aria-label={refreshLabel} title={refreshLabel}>
            {busy || usage?.refreshing ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
          </button>
        )}
      </span>
      {refreshError && <small className="usage-warning" role="status">{refreshError}</small>}
    </span>
  );
}
