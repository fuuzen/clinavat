import { Check, ChevronDown, LoaderCircle, RefreshCw, ShieldCheck, Shuffle } from "lucide-react";
import { useState } from "react";
import { statusLabel } from "../../api";
import type { AccountSelection, Slot, SlotUsage, UsageWindow } from "../../types";
import { refreshSlotUsage, useNow, useSlotUsage } from "../../useSlotUsage";
import SlotUsageRing from "../usage/SlotUsageRing";
import { accountWindows, slotUsageRings } from "../usage/slot-usage-rings";
import SettingsHelp from "./SettingsHelp";
import SettingsMenu from "./SettingsMenu";

interface Props {
  slots: Slot[];
  slotId: string;
  selection: AccountSelection;
  engine?: "claude" | "codex";
  disabled: boolean;
  saving: boolean;
  onChange: (selection: AccountSelection) => void;
}

export default function SlotPicker({ slots, slotId, selection, engine, disabled, saving, onChange }: Props) {
  const usage = useSlotUsage(slots.length > 0);
  const now = useNow();
  const selected = slots.find((slot) => slot.id === slotId);
  const available = slots.filter((slot) => !engine || slot.engine === engine);
  const name = selection.slotMode === "auto" ? selected ? `自动 · ${selected.label}` : "自动选择"
    : selected?.label || (slotId ? "槽位不可用" : "选择账号");
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
      {(close) => <SlotMenu available={available} slotId={slotId} selection={selection} engine={engine} usage={usage} now={now} onChange={onChange} close={close} />}
    </SettingsMenu>
  );
}

function windowName(window: UsageWindow): string {
  const minutes = window.windowMinutes;
  if (!minutes) return window.label;
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function untilReset(window: UsageWindow, now: number): string {
  if (!window.resetsAt) return "";
  const minutes = Math.ceil((Date.parse(window.resetsAt) - now) / 60_000);
  if (minutes <= 0) return "待刷新";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d${hours ? `${hours}h` : ""}` : hours ? `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}` : `${minutes}m`;
}

// The same windows the trigger ring draws: the account total first, then the 5-hour window when present.
function SlotQuota({ slot, usage, now }: { slot: Slot; usage?: SlotUsage; now: number }) {
  if (!usage || usage.state === "pending") return <span className="slot-menu-quota"><small>{usage?.refreshing ? "查询中…" : "未查询"}</small></span>;
  if (usage.state !== "ok") return <span className="slot-menu-quota"><small>无额度数据</small></span>;
  const { main, fiveHour } = accountWindows(slot.engine, usage.windows);
  const windows = [main, fiveHour].filter((window): window is UsageWindow => !!window);
  if (!windows.length) return <span className="slot-menu-quota"><small>无额度窗口</small></span>;
  return (
    <span className={`slot-menu-quota${usage.stale ? " stale" : ""}`}>
      {windows.map((window) => {
        const used = window.usedPercent;
        const level = used === null ? "" : used >= 90 || window.limited ? "critical" : used >= 70 ? "warning" : "";
        return (
          <span className="slot-menu-window" key={window.key}>
            <span>{windowName(window)}</span>
            <span className={`usage-bar ${level}`}>
              <span style={{ width: `${Math.min(100, Math.max(0, used ?? 0))}%` }} />
            </span>
            <span>{untilReset(window, now)}</span>
          </span>
        );
      })}
    </span>
  );
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

function SlotMenu({ available, slotId, selection, engine, usage, now, onChange, close }: {
  available: Slot[]; slotId: string; selection: AccountSelection; engine?: "claude" | "codex"; usage: Record<string, SlotUsage>; now: number;
  onChange: (selection: AccountSelection) => void; close: () => void;
}) {
  return (
        <>
          <div className="settings-menu-heading">
            <span>当前对话的授权槽位</span>
            <SettingsHelp menuItem text={"Claude 自动选择可用账号，额度耗尽时切换账号继续当前任务。选择具体账号后仅使用该账号。\n切换仅影响当前对话。额度条为已用比例，右侧为距重置的时间；查询失败时显示上次获取的数据。"} />
          </div>
          {(["claude", "codex"] as const).map((type) => {
            const matching = available.filter((slot) => slot.engine === type);
            if (!matching.length) return null;
            return (
              <div key={type} role="group" aria-label={type === "claude" ? "Claude Code 账号" : "Codex 账号"}>
                <div className="slot-menu-engine">{type === "claude" ? "Claude Code" : "Codex"}</div>
                {type === "claude" && (
                  <button type="button" className="settings-menu-item" role="menuitemradio"
                    aria-checked={selection.slotMode === "auto" && selection.engine === "claude"} tabIndex={-1}
                    disabled={!matching.some(slot => slot.status === "IDLE" && (!slot.in_use || slot.in_use_by_you))}
                    onClick={() => { onChange({ engine: "claude", slotMode: "auto" }); close(); }}>
                    <Shuffle size={16} aria-hidden="true" />
                    <span className="settings-item-copy"><span className="settings-item-name">自动选择</span><small>额度耗尽时自动切换账号</small></span>
                    <Check size={14} className="settings-item-check" aria-hidden="true" />
                  </button>
                )}
                {matching.map((slot) => {
                  const slotUsage = usage[slot.id];
                  const limited = slot.status === "RATE_LIMITED";
                  return (
                    <div className="settings-menu-entry" key={slot.id}>
                      <button
                        type="button"
                        className="settings-menu-item"
                        role="menuitemradio"
                        aria-checked={selection.slotMode === "manual" && slot.id === slotId}
                        tabIndex={-1}
                        disabled={slot.status !== "IDLE" || (slot.in_use && !slot.in_use_by_you)}
                        title={slotUsageRings(slot.engine, slotUsage, now, limited).description}
                        onClick={() => { onChange({ engine: slot.engine, slotMode: "manual", slotId: slot.id }); close(); }}
                      >
                        <SlotUsageRing engine={slot.engine} usage={slotUsage} now={now} slotLimited={limited} plain />
                        <span className="slot-menu-label">{slot.label}</span>
                        {slot.status !== "IDLE" && <span className="badge">{statusLabel(slot.status)}</span>}
                        {slot.status !== "DISABLED" && <SlotQuota slot={slot} usage={slotUsage} now={now} />}
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
