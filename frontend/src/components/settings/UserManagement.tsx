import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { api, errorText, post, statusLabel } from "../../api";
import type { Slot, User } from "../../types";
import UserCreateForm from "./UserCreateForm";

interface Props {
  onRefresh: () => Promise<void>;
  onSlots: () => void;
}

function creationDate(value: string) {
  if (!value) return "未知日期";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export default function UserManagement({ onRefresh, onSlots }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    user: User;
    slot: Slot | null;
  } | null>(null);
  const load = useCallback(async () => {
    const [nextUsers, nextSlots] = await Promise.all([
      api<User[]>("/admin/users"),
      api<Slot[]>("/admin/slots"),
    ]);
    setUsers(nextUsers);
    setSlots(nextSlots);
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function create(username: string, password: string) {
    setCreating(true);
    setCreated(null);
    setError("");
    try {
      const result = await post<{ user: User; slot: Slot | null }>(
        "/admin/users",
        { username, password },
      );
      setCreated(result);
      setUsers((current) => [result.user, ...current]);
      const assignedSlot = result.slot;
      if (assignedSlot)
        setSlots((current) => [
          ...current.filter((slot) => slot.id !== assignedSlot.id),
          assignedSlot,
        ]);
      try {
        await onRefresh();
        await load();
      } catch (cause) {
        setError(`用户已创建，但刷新失败：${errorText(cause)}`);
      }
    } finally {
      setCreating(false);
    }
  }
  const unassigned = users.filter(
    (user) => !slots.some((slot) => slot.assigned_user_id === user.id),
  ).length;
  return (
    <>
      <div className="settings-section-heading">
        <Users size={18} />
        <h3>用户管理</h3>
        <button
          className="button button-secondary button-small"
          disabled={creating}
          onClick={() => {
            setAdding(!adding);
            setCreated(null);
          }}
        >
          <UserPlus size={13} />
          {adding ? "收起表单" : "创建用户"}
        </button>
      </div>
      <p className="settings-description">
        由管理员创建普通成员，无需开放注册。新成员会自动领取空闲账号槽位；没有可用槽位时，可先创建账号，稍后分配。
      </p>
      {created && (
        <div className="success-note user-created-note" role="status">
          <Check size={15} />
          <div>
            <strong>用户「{created.user.username}」已创建</strong>
            <span>
              {created.slot
                ? `已自动绑定 ${created.slot.label}（${created.slot.id}）。`
                : "当前没有空闲槽位，账号已创建，等待分配。"}
            </span>
            {!created.slot && (
              <button className="text-button" onClick={onSlots}>
                前往账号槽位分配
                <ArrowUpRight size={12} />
              </button>
            )}
          </div>
        </div>
      )}
      {adding && (
        <UserCreateForm onCreate={create} onCancel={() => setAdding(false)} />
      )}
      <div className="users-list-heading">
        <span>
          {loading && users.length === 0
            ? "正在加载成员…"
            : `${users.length} 位用户 · ${unassigned} 位待分配`}
        </span>
        <button
          className="icon-button"
          disabled={loading || creating}
          onClick={() => void refresh()}
          aria-label="刷新用户列表"
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {loading && users.length === 0 ? (
        <div className="loading-state">
          <LoaderCircle size={20} className="spin" />
        </div>
      ) : users.length === 0 ? (
        <div className="settings-empty">
          <Users size={29} />
          <strong>邀请成员进入工作台</strong>
          <p>创建账号后，成员即可使用自己的身份登录。</p>
        </div>
      ) : (
        <div className="user-management-list">
          {users.map((user) => {
            const slot = slots.find(
              (item) => item.assigned_user_id === user.id,
            );
            return (
              <article className="managed-user" key={user.id}>
                <div className="managed-user-heading">
                  <span className="avatar">
                    {user.username.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{user.username}</strong>
                    <small>创建于 {creationDate(user.created_at)}</small>
                  </div>
                  <span
                    className={`badge ${user.role === "admin" ? "badge-green" : ""}`}
                  >
                    {user.role === "admin" ? "管理员" : "普通成员"}
                  </span>
                </div>
                <div className="managed-user-slot">
                  <ShieldCheck size={13} />
                  {slot ? (
                    <>
                      <span>
                        {slot.label}
                        <small>{slot.id}</small>
                      </span>
                      <span
                        className={`badge ${slot.status === "ASSIGNED" ? "badge-green" : ""}`}
                      >
                        {statusLabel(slot.status)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>
                        账号槽位
                        <span className="badge badge-amber">待分配</span>
                      </span>
                      <button className="text-button" onClick={onSlots}>
                        分配槽位
                        <ArrowUpRight size={11} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
