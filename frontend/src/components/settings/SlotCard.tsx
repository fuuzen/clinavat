import { ShieldCheck, Terminal } from "lucide-react";
import type { Slot, SlotUsage, User } from "../../types";
import SlotUsageMeter from "../usage/SlotUsageMeter";
import MobileCardDetails from "../admin/MobileCardDetails";
import { CopyButton } from "../Dialogs";
import SlotUserPicker from "./SlotUserPicker";
import "../../styles/slot-admin-card.css";

interface Props {
  slot: Slot;
  usage?: SlotUsage;
  users: User[];
  busy: boolean;
  onUpdate: (slot: Slot, values: Record<string, unknown>) => Promise<void>;
  assignmentVersion?: number;
  assignmentError?: string;
}

function loginCommand(slot: Slot): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const home = slot.home_dir!;
  return slot.engine === "claude"
    ? `HOME=${quote(home)} CLAUDE_CONFIG_DIR=${quote(`${home}/.claude`)} claude auth login`
    : `HOME=${quote(home)} CODEX_HOME=${quote(`${home}/.codex`)} codex -c 'cli_auth_credentials_store="file"' login --device-auth`;
}

export default function SlotCard({ slot, usage, users, busy, onUpdate, assignmentVersion = 0, assignmentError }: Props) {
  const allowedIds = slot.allowed_user_ids || [];
  const shared = allowedIds.length > 1;
  const owner = allowedIds.length === 1 ? users.find((user) => user.id === allowedIds[0]) : undefined;
  const ownerLabel = shared ? `${allowedIds.length} 人授权 · 待整理` : owner?.username || (allowedIds.length ? "用户信息待更新" : "未分配");
  const running = Boolean(slot.active_user_id || slot.in_use);
  const enabled = slot.status !== "DISABLED";
  const command = slot.home_dir ? loginCommand(slot) : "";
  return (
    <article className="slot-admin-card">
      <div className="slot-admin-heading">
        <span className="slot-icon"><ShieldCheck size={17} /></span>
        <div>
          <strong>{slot.label}</strong>
          <small>{slot.id} · {slot.engine === "claude" ? "Claude Code" : "Codex"}</small>
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
        {slot.status !== "DISABLED" && <SlotUsageMeter slotId={slot.id} usage={usage} refreshable />}
        {command && (
          <details>
            <summary><Terminal size={12} />服务器登录命令</summary>
            <p className="slot-login-note">请先停止使用该槽位的任务，再以运行服务的系统用户完成登录。</p>
            <pre>{command}</pre>
            <CopyButton value={command} />
          </details>
        )}
      </MobileCardDetails>
    </article>
  );
}
