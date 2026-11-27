import { useState, type FormEvent } from "react";
import { Check, LoaderCircle, Pencil, RefreshCw, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import { errorText, post } from "../../api";
import type { ModelCatalog, Slot, SlotUsage, User } from "../../types";
import SlotUsageMeter from "../usage/SlotUsageMeter";
import LimitResetDialog, { limitResetOffer, resetCreditsText } from "../usage/LimitReset";
import MobileCardDetails from "../admin/MobileCardDetails";
import SlotLogin from "./SlotLogin";
import SlotUserPicker from "./SlotUserPicker";
import { engineLabel, engineProfiles } from "../../engines";
import "../../styles/slot-admin-card.css";

interface Props {
  slot: Slot;
  usage?: SlotUsage;
  users: User[];
  busy: boolean;
  onUpdate: (slot: Slot, values: Record<string, unknown>) => Promise<void>;
  onLoginChanged: (slot: Slot, message: string) => Promise<void>;
  onDelete: (slot: Slot) => void;
  assignmentVersion?: number;
  assignmentError?: string;
}

export default function SlotCard({ slot, usage, users, busy, onUpdate, onLoginChanged, onDelete, assignmentVersion = 0, assignmentError }: Props) {
  const allowedIds = slot.allowed_user_ids || [];
  const shared = allowedIds.length > 1;
  const owner = allowedIds.length === 1 ? users.find((user) => user.id === allowedIds[0]) : undefined;
  const ownerLabel = shared ? `${allowedIds.length} 人授权 · 待整理` : owner?.username || (allowedIds.length ? "用户信息待更新" : "未分配");
  const running = Boolean(slot.active_user_id || slot.in_use);
  const enabled = slot.status !== "DISABLED";
  return (
    <article className="slot-admin-card">
      <div className="slot-admin-heading">
        <span className="slot-icon"><ShieldCheck size={17} /></span>
        <div>
          <SlotLabel slot={slot} disabled={busy} onSave={(label) => onUpdate(slot, { label })} />
          <small>{slot.id} · {engineLabel(slot.engine)}{slot.auth_method === "token" ? " · 长期令牌" : ""}</small>
        </div>
        <button type="button" role="switch" className="slot-enabled-switch" aria-label={`${slot.label}启用状态`}
          aria-checked={enabled} disabled={busy || running}
          title={running ? "槽位使用中，任务结束后可调整启用状态" : slot.status === "RATE_LIMITED" ? "已启用，当前额度受限" : enabled ? "停用此槽位" : "启用此槽位"}
          onClick={() => void onUpdate(slot, { status: enabled ? "DISABLED" : "IDLE" }).catch(() => {})}>
          <span className="slot-enabled-label">{enabled ? "启用" : "停用"}</span>
          <span className="slot-enabled-thumb" aria-hidden="true" />
        </button>
      </div>
      <MobileCardDetails label={slot.label} summary={<span className={shared ? "slot-assignee-warning" : ""}>{ownerLabel}</span>}>
        <SlotUserPicker key={`${slot.id}:${slot.credential_revision}:${assignmentVersion}`} slot={slot} users={users}
          disabled={busy || running} onSave={(userId) => onUpdate(slot, { allowedUserIds: userId ? [userId] : [] })} />
        {assignmentError && <p className="slot-user-error">{assignmentError}</p>}
        {slot.status !== "DISABLED" && <SlotUsageMeter slotId={slot.id} engine={slot.engine} usage={usage} refreshable={slot.auth_method !== "token"} />}
        {slot.status !== "DISABLED" && slot.auth_method !== "token" && engineProfiles[slot.engine].limitReset && (
          <SlotResetAccess slot={slot} usage={usage} disabled={busy} onChange={(membersCanReset) => onUpdate(slot, { membersCanReset })} />
        )}
        {slot.status !== "DISABLED" && <SlotModels slot={slot} />}
        {slot.home_dir && <SlotLogin slot={slot} disabled={busy || running} onChanged={onLoginChanged} />}
        <button type="button" className="text-button danger-text slot-delete" disabled={busy || running || enabled}
          title={enabled ? "请先停用此槽位，再删除" : running ? "槽位使用中，任务结束后可删除" : undefined}
          onClick={() => onDelete(slot)}>
          <Trash2 size={12} />删除槽位{enabled && "（需先停用）"}
        </button>
      </MobileCardDetails>
    </article>
  );
}

/** The slot's display name, edited in place; renaming never interrupts the slot's work. */
function SlotLabel({ slot, disabled, onSave }: { slot: Slot; disabled: boolean; onSave: (label: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slot.label);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const label = value.trim();
    if (!label || label === slot.label) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(label); setEditing(false); }
    catch { /* The list shows the error and reloads the slot. */ }
    finally { setSaving(false); }
  }
  if (!editing) {
    return (
      <span className="slot-label">
        <strong>{slot.label}</strong>
        <button type="button" className="icon-button" disabled={disabled} aria-label={`修改 ${slot.label} 的名称`} title="修改名称"
          onClick={() => { setValue(slot.label); setEditing(true); }}>
          <Pencil size={12} />
        </button>
      </span>
    );
  }
  return (
    <form className="slot-label slot-label-editing" onSubmit={submit}>
      <input value={value} onChange={(event) => setValue(event.target.value)} maxLength={100} required autoFocus
        disabled={saving} aria-label="槽位名称" onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} />
      <button className="icon-button" disabled={saving} aria-label="保存名称" title="保存">
        {saving ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
      </button>
      <button type="button" className="icon-button" disabled={saving} aria-label="取消修改" title="取消" onClick={() => setEditing(false)}>
        <X size={12} />
      </button>
    </form>
  );
}

/** Whether assigned members may spend the slot's rate-limit resets, and the administrator's own way to spend one. */
function SlotResetAccess({ slot, usage, disabled, onChange }: {
  slot: Slot; usage?: SlotUsage; disabled: boolean; onChange: (membersCanReset: boolean) => Promise<void>;
}) {
  const [resetting, setResetting] = useState(false);
  const offer = limitResetOffer(slot.engine, usage);
  return (
    <div className="slot-reset-access">
      <label>
        <input type="checkbox" checked={slot.members_can_reset} disabled={disabled}
          onChange={(event) => void onChange(event.target.checked).catch(() => {})} />
        允许被分配的成员使用额度重置
      </label>
      <small>
        {engineProfiles[slot.engine].limitReset === "weekly" ? "Claude 每周可重置 1 次 5 小时额度，5 小时额度用尽后可用"
          : resetCreditsText(usage) ?? "暂无可用的重置卡"}
      </small>
      {offer && (
        <button type="button" className="button button-ghost" onClick={() => setResetting(true)}>
          <RotateCcw size={12} />使用重置 · {offer}
        </button>
      )}
      {resetting && <LimitResetDialog slot={slot} usage={usage} onClose={() => setResetting(false)} />}
    </div>
  );
}

/** The slot's saved model list, read from its CLI again only on request. */
function SlotModels({ slot }: { slot: Slot }) {
  const [catalog, setCatalog] = useState<{ count: number | null; refreshedAt: string | null; runAs?: string }>({ count: null, refreshedAt: slot.model_catalog_at ?? null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const result = await post<ModelCatalog>(`/slots/${slot.id}/models/refresh`);
      setCatalog({ count: result.models.length, refreshedAt: result.refreshedAt, runAs: result.runAs });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const label = `刷新 ${slot.label} 的模型列表`;
  return (
    <span className="slot-models">
      <span className="usage-meter-status">
        <small>
          模型列表：{catalog.refreshedAt
            ? `${catalog.count === null ? "" : `${catalog.count} 个模型 · `}更新于 ${new Date(catalog.refreshedAt).toLocaleString("zh-CN")}`
            : "尚未读取，首次使用时自动读取"}
          {catalog.runAs && ` · 以槽位用户 ${catalog.runAs} 的配置读取`}
        </small>
        <button type="button" className="icon-button" disabled={busy} aria-busy={busy} aria-label={label} title={label}
          onClick={() => void refresh()}>
          {busy ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
        </button>
      </span>
      {error && <small className="usage-warning" role="status">{error}</small>}
    </span>
  );
}
