import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "../../api";
import type { LimitResetResult, Slot, SlotUsage } from "../../types";
import { resetSlotLimit } from "../../useSlotUsage";
import { Modal } from "../Dialogs";
import "../../styles/limit-reset.css";

function used(usage: SlotUsage, key: string): number {
  return usage.windows.find((window) => window.key === key)?.usedPercent ?? 0;
}

function date(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * What a reset could do for the slot right now, or null. Claude offers its weekly reset only once the 5-hour window
 * is used up, and it cannot help while the week is used up as well.
 */
export function limitResetOffer(engine: Slot["engine"], usage?: SlotUsage): string | null {
  if (!usage || usage.state !== "ok") return null;
  if (engine === "codex") return usage.resetCredits?.available ? `可用重置卡 ${usage.resetCredits.available} 张` : null;
  return used(usage, "five_hour") >= 100 && used(usage, "seven_day") < 100 ? "可重置 5 小时额度（每周 1 次）" : null;
}

export function limitResetDisabledReason(slot: Slot, usage?: SlotUsage): string | null {
  if (slot.status === "DISABLED") return "槽位已停用，暂不能使用额度重置";
  if (slot.auth_method === "token") return "长期令牌账号不支持额度重置";
  if (!usage || usage.state === "pending") return "额度尚未就绪，请先刷新额度";
  if (usage.state !== "ok") return "暂时无法确认重置条件，请刷新额度后重试";
  if (limitResetOffer(slot.engine, usage)) return null;
  if (slot.engine === "codex") return "暂无可用的重置卡";
  if (used(usage, "seven_day") >= 100) return "每周额度已用尽，重置 5 小时额度无法恢复使用";
  return "5 小时额度用尽后可重置（每周 1 次）";
}

/** The earliest expiry among the Codex credits the service listed. */
export function resetCreditsText(usage?: SlotUsage): string | null {
  const summary = usage?.resetCredits;
  if (!summary?.available) return null;
  const expiries = (summary.credits ?? []).map((credit) => credit.expiresAt).filter((value): value is string => !!value).sort();
  return `重置卡：${summary.available} 张${expiries.length ? ` · 最早 ${date(expiries[0])} 到期` : ""}`;
}

export default function LimitResetDialog({ slot, usage, onClose }: { slot: Slot; usage?: SlotUsage; onClose: () => void }) {
  const [creditId, setCreditId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LimitResetResult | null>(null);
  const credits = slot.engine === "codex" ? usage?.resetCredits?.credits ?? [] : [];
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      setResult(await resetSlotLimit(slot.id, creditId || undefined));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="使用额度重置" subtitle={slot.label} onClose={() => { if (!busy) onClose(); }}>
      <form className="modal-form limit-reset" onSubmit={(event) => { event.preventDefault(); if (!busy && !result) void confirm(); }}>
        {result ? (
          <div className="limit-reset-result" role="status">
            <p>{result.message}</p>
            {result.detail && <small>{slot.engine === "claude" ? "Claude Code" : "Codex"}：{result.detail}</small>}
          </div>
        ) : slot.engine === "claude" ? (
          <div className="danger-dialog-body">
            <p>将立即重置该账号的 5 小时额度。Claude 每周只提供 1 次，重置后的用量仍计入每周额度，用掉后无法撤销。</p>
            <small>后台会启动 Claude Code，先发送一条会被额度拒绝的消息，再执行 <code>/limit-reset</code>，约需 1 分钟。</small>
          </div>
        ) : (
          <div className="danger-dialog-body">
            <p>将消耗 1 张重置卡，立即重置该账号当前的额度窗口，用掉后无法撤销。没有可重置的窗口时不会消耗重置卡。</p>
            {credits.length > 0 && (
              <label>
                <span>使用的重置卡</span>
                <select value={creditId} onChange={(event) => setCreditId(event.target.value)} disabled={busy}>
                  <option value="">由 Codex 自动选择</option>
                  {credits.map((credit) => (
                    <option key={credit.id} value={credit.id}>
                      {credit.title || "重置卡"}{credit.expiresAt ? ` · ${date(credit.expiresAt)} 到期` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          {result ? (
            <button type="button" className="button button-primary" onClick={onClose}>关闭</button>
          ) : (
            <>
              <button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>取消</button>
              <button className="button button-danger" disabled={busy}>
                {busy && <LoaderCircle size={14} className="spin" />}{busy ? "正在重置…" : "使用重置"}
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
