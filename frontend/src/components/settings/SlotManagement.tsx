import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Check,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Terminal,
  Users,
} from "lucide-react";
import { api, errorText, post, statusLabel } from "../../api";
import type { Slot, User } from "../../types";
import { CopyButton } from "../Dialogs";

export default function SlotManagement({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [engines, setEngines] = useState(["claude", "codex"]);
  const [success, setSuccess] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [newSlots, newUsers] = await Promise.all([
        api<Slot[]>("/admin/slots"),
        api<User[]>("/admin/users"),
      ]);
      setSlots(newSlots);
      setUsers(newUsers);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function update(slot: Slot, values: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(`/admin/slots/${slot.id}`, {
        method: "PATCH",
        body: JSON.stringify(values),
      });
      await Promise.all([load(), onRefresh()]);
      setSuccess("槽位配置已更新");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
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
        cliTypes: engines,
      });
      setAdding(false);
      await Promise.all([load(), onRefresh()]);
      setSuccess("账号槽位已创建，请在服务器完成官方 CLI 登录。");
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
        <div className="settings-section-heading">
          <Users size={18} />
          <h3>账号槽位</h3>
          <button
            className="button button-secondary button-small"
            onClick={() => setAdding(!adding)}
          >
            <Plus size={13} />
            创建槽位
          </button>
        </div>
        <p className="settings-description">
          一位用户绑定一个独立槽位。创建后，在服务器中使用该槽位的 HOME 完成官方
          CLI 登录。
        </p>
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
            <div className="checkbox-row">
              {["claude", "codex"].map((engine) => (
                <label key={engine}>
                  <input
                    type="checkbox"
                    checked={engines.includes(engine)}
                    onChange={(event) =>
                      setEngines((current) =>
                        event.target.checked
                          ? [...current, engine]
                          : current.filter((item) => item !== engine),
                      )
                    }
                  />
                  {engine === "claude" ? "Claude Code" : "Codex"}
                </label>
              ))}
            </div>
            <button
              className="button button-primary button-small"
              disabled={busy || !engines.length}
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
            <strong>给每个人一个专属空间</strong>
            <p>创建你的第一个账号槽位，开始管理 CLI 账号。</p>
          </div>
        ) : (
          <div className="slots-list">
            {slots.map((slot) => (
              <div className="slot-admin-card" key={slot.id}>
                <div className="slot-admin-heading">
                  <span className="slot-icon">
                    <ShieldCheck size={17} />
                  </span>
                  <div>
                    <strong>{slot.label}</strong>
                    <small>
                      {slot.id} · {slot.cli_types.join(" / ")}
                    </small>
                  </div>
                  <span
                    className={`badge ${slot.status === "ASSIGNED" ? "badge-green" : ""}`}
                  >
                    {statusLabel(slot.status)}
                  </span>
                </div>
                <div className="form-row">
                  <label>
                    绑定用户
                    <select
                      aria-label={`${slot.label}绑定用户`}
                      disabled={busy || !!slot.assigned_user_id}
                      value={slot.assigned_user_id || ""}
                      onChange={(event) => {
                        if (event.target.value)
                          void update(slot, {
                            assignedUserId: event.target.value,
                          });
                      }}
                    >
                      <option value="" disabled>
                        选择用户（永久绑定）
                      </option>
                      {users
                        .filter(
                          (user) =>
                            user.id === slot.assigned_user_id ||
                            !slots.some(
                              (item) => item.assigned_user_id === user.id,
                            ),
                        )
                        .map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.username}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    状态
                    <select
                      aria-label={`${slot.label}状态`}
                      disabled={busy}
                      value={slot.status}
                      onChange={(event) =>
                        void update(slot, { status: event.target.value })
                      }
                    >
                      {(slot.assigned_user_id
                        ? ["ASSIGNED", "RATE_LIMITED", "DISABLED"]
                        : ["IDLE", "DISABLED"]
                      ).map((status) => (
                        <option key={status} value={status}>
                          {statusLabel(status)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {slot.home_dir && (
                  <details>
                    <summary>
                      <Terminal size={12} />
                      服务器登录命令
                    </summary>
                    <pre>
                      {slot.cli_types
                        .map(
                          (engine) =>
                            `HOME='${slot.home_dir!.replace(/'/g, "'\\''")}' ${engine === "claude" ? "claude auth login" : "codex login --device-auth"}`,
                        )
                        .join("\n")}
                    </pre>
                    <CopyButton
                      value={slot.cli_types
                        .map(
                          (engine) =>
                            `HOME='${slot.home_dir!.replace(/'/g, "'\\''")}' ${engine === "claude" ? "claude auth login" : "codex login --device-auth"}`,
                        )
                        .join("\n")}
                    />
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </>
    </>
  );
}
