import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  LoaderCircle,
  Plus,
  RefreshCw,
  Users,
} from "lucide-react";
import { api, errorText, post } from "../../api";
import type { Slot, User } from "../../types";
import SlotCard from "./SlotCard";
import { useSlotUsage } from "../../useSlotUsage";

export default function SlotManagement({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const usage = useSlotUsage(true);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [requiresReload, setRequiresReload] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [engine, setEngine] = useState<"claude" | "codex">("claude");
  const [success, setSuccess] = useState("");
  const [assignmentVersions, setAssignmentVersions] = useState<Record<string, number>>({});
  const [assignmentErrors, setAssignmentErrors] = useState<Record<string, string>>({});
  const updating = useRef(false);
  const load = useCallback(async () => {
    const [newSlots, newUsers] = await Promise.all([
      api<Slot[]>("/admin/slots"),
      api<User[]>("/admin/users"),
    ]);
    setSlots(newSlots);
    setUsers(newUsers);
    setRequiresReload(false);
    return newSlots;
  }, []);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const refreshed = await load();
      setAssignmentVersions((current) => Object.fromEntries(refreshed.map((slot) => [slot.id, (current[slot.id] || 0) + 1])));
      setAssignmentErrors({});
    } catch (cause) {
      setError(errorText(cause));
      setRequiresReload(true);
    } finally {
      setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function update(slot: Slot, values: Record<string, unknown>) {
    if (updating.current || requiresReload) throw new Error("请等待当前操作完成，或刷新后重试。");
    updating.current = true;
    setBusy(true);
    setError("");
    setSuccess("");
    setAssignmentErrors((current) => ({ ...current, [slot.id]: "" }));
    try {
      let updated: Slot;
      try {
        updated = await api<Slot>(`/admin/slots/${slot.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...values, expectedRevision: slot.credential_revision }),
        });
      } catch (cause) {
        const [reloadResult] = await Promise.allSettled([load(), onRefresh()]);
        if (reloadResult.status === "rejected") setRequiresReload(true);
        setAssignmentVersions((current) => ({ ...current, [slot.id]: (current[slot.id] || 0) + 1 }));
        const message = reloadResult.status === "rejected"
          ? `${errorText(cause)}；最新槽位加载失败：${errorText(reloadResult.reason)}。请刷新列表后重试。`
          : `${errorText(cause)}。已刷新最新状态，请确认后重试。`;
        setError(message);
        setAssignmentErrors((current) => ({ ...current, [slot.id]: message }));
        throw cause;
      }
      setSlots((current) => current.map((item) => item.id === updated.id ? updated : item));
      setAssignmentVersions((current) => ({ ...current, [slot.id]: (current[slot.id] || 0) + 1 }));
      setSuccess(values.allowedUserIds !== undefined ? `「${slot.label}」的用户分配已保存` : "槽位配置已更新");
      const [reloadResult, overviewResult] = await Promise.allSettled([load(), onRefresh()]);
      if (reloadResult.status === "rejected") {
        setRequiresReload(true);
        setError(`配置已保存，但列表刷新失败：${errorText(reloadResult.reason)}。请刷新后再操作。`);
      } else if (overviewResult.status === "rejected") {
        setError(`配置已保存，但工作台刷新失败：${errorText(overviewResult.reason)}。`);
      }
    } finally {
      updating.current = false;
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await post("/admin/slots", {
        id: data.get("id"),
        label: data.get("label"),
        engine,
      });
      setAdding(false);
      await Promise.all([load(), onRefresh()]);
      setSuccess("槽位已创建，请完成官方 CLI 登录，并在卡片中选择使用者。");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="success-note">
          <Check size={14} />
          {success}
        </div>
      )}
      <>
        <div className="management-toolbar">
          <p className="settings-description">在卡片中管理 CLI 账号、额度和使用者，点击用户选择框搜索成员，选中即保存。</p>
          <div className="management-toolbar-actions">
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={() => void refresh()}
              aria-label="刷新槽位列表"
              title="刷新槽位列表"
            >
              <RefreshCw size={14} className={busy ? "spin" : ""} />
            </button>
            <button
              className="button button-secondary button-small"
              disabled={busy}
              onClick={() => setAdding(!adding)}
            >
              <Plus size={13} />
              创建槽位
            </button>
          </div>
        </div>
        {adding && (
          <form className="slot-create" onSubmit={create}>
            <div className="form-row">
              <label>
                槽位 ID
                <input
                  name="id"
                  placeholder="slot_01"
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                  maxLength={48}
                  required
                />
              </label>
              <label>
                显示名称
                <input name="label" placeholder="个人开发账号" required />
              </label>
            </div>
            <label>
              CLI 引擎
              <select value={engine} onChange={(event) => setEngine(event.target.value as "claude" | "codex")}>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <button
              className="button button-primary button-small"
              disabled={busy}
            >
              {busy && <LoaderCircle size={13} className="spin" />}创建
            </button>
          </form>
        )}
        {busy && slots.length === 0 ? (
          <div className="loading-state">
            <LoaderCircle size={20} className="spin" />
          </div>
        ) : slots.length === 0 ? (
          <div className="settings-empty">
            <Users size={29} />
            <strong>管理 CLI 账号授权</strong>
            <p>创建你的第一个账号槽位，开始管理 CLI 账号。</p>
          </div>
        ) : (
          <div className="slots-list">
            {slots.map((slot) => (
              <SlotCard
                key={slot.id}
                slot={slot}
                usage={usage[slot.id]}
                users={users}
                busy={busy || requiresReload}
                onUpdate={update}
                assignmentVersion={assignmentVersions[slot.id] || 0}
                assignmentError={assignmentErrors[slot.id]}
              />
            ))}
          </div>
        )}
      </>
    </>
  );
}
