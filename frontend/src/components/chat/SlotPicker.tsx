import { Check, ChevronDown, CircleHelp, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { statusLabel } from "../../api";
import type { Slot, SlotUsage } from "../../types";
import { refreshSlotUsage, useNow, useSlotUsage } from "../../useSlotUsage";
import SlotUsageRing from "../usage/SlotUsageRing";
import { accountWindows, slotUsageRings } from "../usage/slot-usage-rings";
import SettingsMenu from "./SettingsMenu";

interface Props {
  slots: Slot[];
  slotId: string;
  engine?: "claude" | "codex";
  disabled: boolean;
  saving: boolean;
  onChange: (slotId: string) => void;
}

export default function SlotPicker({ slots, slotId, engine, disabled, saving, onChange }: Props) {
  const usage = useSlotUsage(slots.length > 0);
  const now = useNow();
  const selected = slots.find((slot) => slot.id === slotId);
  const available = slots.filter((slot) => !engine || slot.engine === engine);
  const name = selected?.label || (slotId ? "槽位不可用" : "选择账号");
  const usageDescription = selected
    ? slotUsageRings(selected.engine, usage[selected.id], now, selected.status === "RATE_LIMITED").description : "";
  const title = `当前对话的授权槽位：${name}${selected ? ` · ${selected.engine === "claude" ? "Claude Code" : "Codex"}；${usageDescription}` : ""}${saving ? "；正在切换槽位" : ""}`;
  return (
    <SettingsMenu
      label="授权槽位"
      title={title}
      className="slot-trigger"
      disabled={disabled || saving}
      trigger={(
        <>
          {selected ? <SlotUsageRing engine={selected.engine} usage={usage[selected.id]} now={now} saving={saving}
            slotLimited={selected.status === "RATE_LIMITED"} /> : <span className="engine-symbol" aria-hidden="true">
              {saving ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
            </span>}
          <span className="settings-trigger-label">{name}</span>
          {!saving && <ChevronDown size={12} className="settings-trigger-chevron" aria-hidden="true" />}
        </>
      )}
    >
      {(close) => <SlotMenu available={available} slotId={slotId} engine={engine} usage={usage} now={now} onChange={onChange} close={close} />}
    </SettingsMenu>
  );
}

// Remaining share of the windows the ring draws, so the row reads the same as its ring.
function usageSummary(slot: Slot, usage: SlotUsage | undefined): string {
  if (!usage || usage.state === "pending") return usage?.refreshing ? "查询中…" : "";
  if (usage.state !== "ok") return "无额度数据";
  const { main, fiveHour } = accountWindows(slot.engine, usage.windows);
  const parts = ([[fiveHour, "5h"], [main, main?.windowMinutes === 10080 ? "周" : main?.label]] as const)
    .flatMap(([window, label]) => window && window.usedPercent !== null ? [`${label} ${Math.max(0, 100 - window.usedPercent)}%`] : []);
  return parts.join(" · ") || "无额度窗口";
}

function SlotRefresh({ slot, usage }: { slot: Slot; usage?: SlotUsage }) {
  const [busy, setBusy] = useState(false);
  const pending = busy || !!usage?.refreshing;
  const label = `刷新 ${slot.label} 的额度`;
  return (
    <button type="button" className="icon-button slot-menu-refresh" role="menuitem" tabIndex={-1} disabled={pending}
      aria-busy={pending} aria-label={label} title={label}
      onClick={() => {
        setBusy(true);
        // Failures arrive through the usage store as a stale entry with its error.
        void refreshSlotUsage(slot.id).catch(() => undefined).finally(() => setBusy(false));
      }}>
      {pending ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
    </button>
  );
}

function SlotMenu({ available, slotId, engine, usage, now, onChange, close }: {
  available: Slot[]; slotId: string; engine?: "claude" | "codex"; usage: Record<string, SlotUsage>; now: number;
  onChange: (slotId: string) => void; close: () => void;
}) {
  const [help, setHelp] = useState(false);
  const helpId = useId();
  return (
        <>
          <div className="settings-menu-heading">
            <span>当前对话的授权槽位</span>
            <button type="button" className="icon-button settings-menu-help" role="menuitemcheckbox" tabIndex={-1}
              aria-checked={help} aria-controls={helpId} aria-label="槽位说明" title="槽位说明" onClick={() => setHelp(!help)}>
              <CircleHelp size={14} aria-hidden="true" />
            </button>
          </div>
          {help && <div id={helpId} className="settings-menu-note">切换仅影响当前对话，你可以在多个对话中同时使用不同槽位。额度以账号服务端返回为准，查询失败时显示最近一次获取的数据作为参考。</div>}
          {(["claude", "codex"] as const).map((type) => {
            const matching = available.filter((slot) => slot.engine === type);
            if (!matching.length) return null;
            return (
              <div key={type} role="group" aria-label={type === "claude" ? "Claude Code 账号" : "Codex 账号"}>
                <div className="slot-menu-engine">{type === "claude" ? "Claude Code" : "Codex"}</div>
                {matching.map((slot) => {
                  const slotUsage = usage[slot.id];
                  const limited = slot.status === "RATE_LIMITED";
                  const summary = slot.status === "DISABLED" ? "" : usageSummary(slot, slotUsage);
                  return (
                    <div className="slot-menu-entry" key={slot.id}>
                      <button
                        type="button"
                        className="settings-menu-item"
                        role="menuitemradio"
                        aria-checked={slot.id === slotId}
                        tabIndex={-1}
                        disabled={slot.status !== "IDLE" || (slot.in_use && !slot.in_use_by_you)}
                        title={slotUsageRings(slot.engine, slotUsage, now, limited).description}
                        onClick={() => { onChange(slot.id); close(); }}
                      >
                        <SlotUsageRing engine={slot.engine} usage={slotUsage} now={now} slotLimited={limited} />
                        <span className="slot-menu-label">{slot.label}</span>
                        {slot.status !== "IDLE" && <span className="badge">{statusLabel(slot.status)}</span>}
                        {summary && <small className={`slot-menu-summary${slotUsage?.stale ? " stale" : ""}`}>{summary}</small>}
                        <Check size={14} className="settings-item-check" aria-hidden="true" />
                      </button>
                      {slot.status !== "DISABLED" && <SlotRefresh slot={slot} usage={slotUsage} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!available.length && <div className="settings-menu-status">暂无获授权的{engine ? ` ${engine === "claude" ? "Claude Code" : "Codex"}` : ""}槽位，请联系管理员。</div>}
        </>
  );
}
