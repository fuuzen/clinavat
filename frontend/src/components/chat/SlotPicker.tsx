import { Check, ChevronDown, LoaderCircle, ShieldCheck } from "lucide-react";
import { statusLabel } from "../../api";
import type { Slot, SlotUsage } from "../../types";
import { useNow, useSlotUsage } from "../../useSlotUsage";
import SlotUsageMeter from "../usage/SlotUsageMeter";
import SlotUsageRing from "../usage/SlotUsageRing";
import { slotUsageRings } from "../usage/slot-usage-rings";
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

function SlotMenu({ available, slotId, engine, usage, now, onChange, close }: {
  available: Slot[]; slotId: string; engine?: "claude" | "codex"; usage: Record<string, SlotUsage>; now: number;
  onChange: (slotId: string) => void; close: () => void;
}) {
  return (
        <>
          <div className="settings-menu-heading"><span>当前对话的授权槽位</span></div>
          {(["claude", "codex"] as const).map((type) => {
            const matching = available.filter((slot) => slot.engine === type);
            if (!matching.length) return null;
            return (
              <div key={type} role="group" aria-label={type === "claude" ? "Claude Code 账号" : "Codex 账号"}>
                <div className="slot-menu-engine">{type === "claude" ? "Claude Code" : "Codex"}</div>
                {matching.map((slot) => {
                  const occupied = slot.in_use && !slot.in_use_by_you;
                  return (
                    <div className="slot-menu-entry" key={slot.id}>
                      <button
                        type="button"
                        className="settings-menu-item"
                        role="menuitemradio"
                        aria-checked={slot.id === slotId}
                        tabIndex={-1}
                        disabled={slot.status !== "IDLE" || occupied}
                        onClick={() => { onChange(slot.id); close(); }}
                      >
                        <SlotUsageRing engine={slot.engine} usage={usage[slot.id]} now={now} slotLimited={slot.status === "RATE_LIMITED"} />
                        <span className="settings-item-copy">
                          <span>{slot.label}</span>
                          <small>{slot.status !== "IDLE" ? statusLabel(slot.status) : occupied ? "其他用户使用中" : slot.in_use_by_you ? "你正在使用" : "可用"}</small>
                        </span>
                        <Check size={14} className="settings-item-check" aria-hidden="true" />
                      </button>
                      {slot.status !== "DISABLED" && (
                        <div className="slot-menu-usage">
                          <SlotUsageMeter slotId={slot.id} usage={usage[slot.id]} compact refreshable
                            refreshRole="menuitem" refreshLabel={`刷新 ${slot.label} 的额度`} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!available.length && <div className="settings-menu-status">暂无获授权的{engine ? ` ${engine === "claude" ? "Claude Code" : "Codex"}` : ""}槽位，请联系管理员。</div>}
          <div className="settings-menu-footnote">切换仅影响当前对话。你可以在多个对话中同时使用不同槽位；每个槽位同时限 1 位用户。额度以账号服务端返回为准。</div>
        </>
  );
}
