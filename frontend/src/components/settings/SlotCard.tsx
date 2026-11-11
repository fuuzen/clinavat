import { useState } from "react";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { errorText, post } from "../../api";
import type { ModelCatalog, Slot, SlotUsage, User } from "../../types";
import SlotUsageMeter from "../usage/SlotUsageMeter";
import MobileCardDetails from "../admin/MobileCardDetails";
import SlotLogin from "./SlotLogin";
import SlotUserPicker from "./SlotUserPicker";
import "../../styles/slot-admin-card.css";

interface Props {
  slot: Slot;
  usage?: SlotUsage;
  users: User[];
  busy: boolean;
  onUpdate: (slot: Slot, values: Record<string, unknown>) => Promise<void>;
  onLoginChanged: (slot: Slot, message: string) => Promise<void>;
  assignmentVersion?: number;
  assignmentError?: string;
}

export default function SlotCard({ slot, usage, users, busy, onUpdate, onLoginChanged, assignmentVersion = 0, assignmentError }: Props) {
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
          <strong>{slot.label}</strong>
          <small>{slot.id} · {slot.engine === "claude" ? "Claude Code" : "Codex"}{slot.auth_method === "token" ? " · 长期令牌" : ""}</small>
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
        {slot.status !== "DISABLED" && <SlotModels slot={slot} />}
        {slot.home_dir && <SlotLogin slot={slot} disabled={busy || running} onChanged={onLoginChanged} />}
      </MobileCardDetails>
    </article>
  );
}

/** The slot's saved model list, read from its CLI again only on request. */
function SlotModels({ slot }: { slot: Slot }) {
  const [catalog, setCatalog] = useState<{ count: number | null; refreshedAt: string | null }>({ count: null, refreshedAt: slot.model_catalog_at ?? null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const result = await post<ModelCatalog>(`/slots/${slot.id}/models/refresh`);
      setCatalog({ count: result.models.length, refreshedAt: result.refreshedAt });
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
