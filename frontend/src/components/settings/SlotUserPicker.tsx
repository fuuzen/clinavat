import { useRef, useState } from "react";
import { errorText } from "../../api";
import type { Slot, User } from "../../types";
import UserSelect, { type UserSelectOption } from "../admin/UserSelect";
import "../../styles/slot-user-picker.css";

interface Props {
  slot: Slot;
  users: User[];
  disabled: boolean;
  onSave: (userId: string | null) => Promise<void>;
}

export default function SlotUserPicker({ slot, users, disabled, onSave }: Props) {
  const assignedIds = slot.allowed_user_ids || [];
  const currentId = assignedIds.length > 1 ? null : assignedIds[0] || "";
  const currentLabel = assignedIds.length > 1 ? `${assignedIds.length} 人授权 · 待整理`
    : users.find((user) => user.id === currentId)?.username || (currentId ? "用户信息待更新" : "未分配");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saveRef = useRef(false);
  const options: UserSelectOption[] = [
    { value: "", label: "未分配", description: "解除此槽位的用户分配", unassigned: true },
    ...users.map((user) => ({ value: user.id, label: user.username, description: user.role === "admin" ? "管理员" : "成员" })),
  ];

  async function select(userId: string) {
    if (saveRef.current || disabled || userId === currentId || (userId && !users.some((user) => user.id === userId))) return;
    saveRef.current = true;
    setSaving(true);
    setError("");
    try { await onSave(userId || null); }
    catch (cause) { setError(errorText(cause)); }
    finally { saveRef.current = false; setSaving(false); }
  }

  return (
    <div className="slot-user-picker">
      <UserSelect options={options} value={currentId} placeholder={currentLabel}
        ariaLabel={`${slot.label}分配用户`} searchLabel={`搜索${slot.label}的分配用户`}
        title={slot.active_user_id || slot.in_use ? "槽位使用中，任务结束后可调整分配" : "搜索并选择用户，选中即保存"}
        disabled={disabled} busy={saving} onChange={(userId) => void select(userId)} />
      {assignedIds.length > 1 && <p className="slot-user-legacy">保留原有多人授权；选择用户后立即替换为单人分配。</p>}
      {error && <p className="slot-user-error" role="alert">{error}</p>}
    </div>
  );
}
