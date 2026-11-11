import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Check, KeyRound, LoaderCircle, Pencil, RefreshCw, RotateCcw, ShieldCheck, Trash2, UserPlus, UserX, Users } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { Slot, User } from "../../types";
import UserCreateForm from "./UserCreateForm";
import UserActionDialog, { type UserAction } from "./UserActionDialog";
import MobileCardDetails from "../admin/MobileCardDetails";

interface Props {
  currentUserId: string;
  onRefresh: () => Promise<void>;
  onSlots: () => void;
}

function creationDate(value: string) {
  if (!value) return "未知日期";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export default function UserManagement({ currentUserId, onRefresh, onSlots }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<User | null>(null);
  const [pending, setPending] = useState<{ user: User; action: UserAction } | null>(null);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [nextUsers, nextSlots] = await Promise.all([api<User[]>("/admin/users"), api<Slot[]>("/admin/slots")]);
    setUsers(nextUsers);
    setSlots(nextSlots);
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try { await load(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function create(username: string, password: string) {
    setCreating(true);
    setCreated(null);
    setError("");
    try {
      const result = await post<{ user: User }>("/admin/users", { username, password });
      setCreated(result.user);
      setUsers((current) => [result.user, ...current]);
      try { await Promise.all([onRefresh(), load()]); }
      catch (cause) { setError(`用户已创建，但刷新失败：${errorText(cause)}`); }
    } finally { setCreating(false); }
  }
  async function actionDone(message: string) {
    setNotice(message);
    setCreated(null);
    try { await Promise.all([onRefresh(), load()]); }
    catch (cause) { setError(`操作已完成，但刷新失败：${errorText(cause)}`); }
  }
  const active = users.filter((user) => !user.suspended_at);
  const suspended = users.length - active.length;
  const unauthorized = active.filter((user) => !slots.some((slot) => slot.allowed_user_ids?.includes(user.id))).length;
  return (
    <>
      <div className="management-toolbar">
        <p className="settings-description"><span className="management-toolbar-summary">{loading && !users.length ? "正在加载成员…" : `${users.length} 位用户 · ${unauthorized} 位尚未分配槽位${suspended ? ` · ${suspended} 位已停用` : ""}`}</span>在「槽位管理」中分配账号；每个槽位限一位用户，同一用户可拥有多个槽位。</p>
        <div className="management-toolbar-actions">
          <button className="icon-button" disabled={loading || creating} onClick={() => void refresh()} aria-label="刷新用户列表" title="刷新用户列表">
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
          <button className="button button-secondary button-small" disabled={creating}
            onClick={() => { setAdding(!adding); setCreated(null); setNotice(""); }}>
            <UserPlus size={13} />{adding ? "收起表单" : "创建用户"}
          </button>
        </div>
      </div>
      {created && (
        <div className="success-note user-created-note" role="status">
          <Check size={15} />
          <div>
            <strong>用户「{created.username}」已创建</strong>
            <span>为新成员分配槽位后，即可开始使用智能体。</span>
            <button className="text-button" onClick={onSlots}>前往槽位管理<ArrowUpRight size={12} /></button>
          </div>
        </div>
      )}
      {notice && <div className="success-note" role="status"><Check size={14} />{notice}</div>}
      {adding && <UserCreateForm onCreate={create} onCancel={() => setAdding(false)} />}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading && !users.length ? (
        <div className="loading-state"><LoaderCircle size={20} className="spin" /></div>
      ) : !users.length ? (
        <div className="settings-empty"><Users size={29} /><strong>邀请成员进入工作台</strong><p>创建账号后，成员即可使用自己的身份登录。</p></div>
      ) : (
        <div className="user-management-list">
          {users.map((user) => {
            const granted = slots.filter((slot) => slot.allowed_user_ids?.includes(user.id));
            const shared = granted.filter((slot) => (slot.allowed_user_ids?.length || 0) > 1).length;
            const self = user.id === currentUserId;
            const actions: { action: UserAction; label: string; icon: typeof Pencil; danger?: boolean }[] = [
              { action: "rename", label: "修改用户名", icon: Pencil },
              { action: "password", label: "重置密码", icon: KeyRound },
              ...(self ? [] : user.suspended_at
                ? [{ action: "restore" as const, label: "恢复用户", icon: RotateCcw }]
                : [{ action: "suspend" as const, label: "停用", icon: UserX }]),
              ...(self ? [] : [{ action: "delete" as const, label: "删除", icon: Trash2, danger: true }]),
            ];
            return (
              <article className={`managed-user${user.suspended_at ? " managed-user-suspended" : ""}`} key={user.id}>
                <div className="managed-user-heading">
                  <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
                  <div><strong>{user.username}</strong><small className="managed-user-created-desktop">创建于 {creationDate(user.created_at)}</small></div>
                  {user.suspended_at && <span className="badge badge-amber" title={`停用于 ${creationDate(user.suspended_at)}`}>已停用</span>}
                  <span className={`badge ${user.role === "admin" ? "badge-green" : ""}`}>{user.role === "admin" ? "管理员" : "普通成员"}</span>
                </div>
                <MobileCardDetails label={user.username} summary={<span>{granted.length ? `${granted.length} 个槽位` : "尚未分配槽位"}{shared > 0 && <span className="managed-user-shared"> · 含 {shared} 个待整理</span>}</span>}>
                  <p className="managed-user-created-mobile">创建于 {creationDate(user.created_at)}</p>
                  <div className="managed-user-slot">
                    <ShieldCheck size={13} />
                    <span>
                      {granted.length ? `${granted.length} 个可访问槽位` : "尚未分配槽位"}
                      {granted.length > 0 && <small>{granted.map((slot) => slot.label).join("、")}</small>}
                      {shared > 0 && <small className="managed-user-shared">含 {shared} 个历史多人授权，待整理为单人分配</small>}
                    </span>
                    <button className="text-button" onClick={onSlots}>管理槽位<ArrowUpRight size={11} /></button>
                  </div>
                  <div className="managed-user-actions">
                    {actions.map(({ action, label, icon: Icon, danger }) => (
                      <button key={action} type="button" className={`text-button${danger ? " danger-text" : ""}`}
                        onClick={() => { setNotice(""); setPending({ user, action }); }}>
                        <Icon size={12} />{label}
                      </button>
                    ))}
                  </div>
                </MobileCardDetails>
              </article>
            );
          })}
        </div>
      )}
      {pending && (
        <UserActionDialog key={`${pending.user.id}:${pending.action}`} user={pending.user} action={pending.action}
          onClose={() => setPending(null)} onDone={actionDone} />
      )}
    </>
  );
}
