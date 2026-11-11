import { useState, type FormEvent } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { User } from "../../types";
import { Modal } from "../Dialogs";
import DangerDialog from "./DangerDialog";

export type UserAction = "rename" | "password" | "suspend" | "restore" | "delete";

interface Props {
  user: User;
  action: UserAction;
  onClose: () => void;
  /** Called after the change is saved, with the message to show. */
  onDone: (message: string) => Promise<void>;
}

const usernamePattern = /^[\p{L}\p{N}_.-]{3,40}$/u;

export default function UserActionDialog({ user, action, onClose, onDone }: Props) {
  if (action === "rename" || action === "password") return <UserFieldDialog user={user} action={action} onClose={onClose} onDone={onDone} />;
  if (action === "suspend") {
    return (
      <DangerDialog title="停用用户" subtitle={user.username} actionLabel="停用并回收资源" onClose={onClose}
        onConfirm={async () => {
          await post(`/admin/users/${user.id}/suspend`);
          await onDone(`已停用「${user.username}」并回收其资源`);
        }}>
        <p>停用后该用户立即退出登录且无法再登录，系统会回收其占用的资源：</p>
        <ul>
          <li>停止正在运行的任务，并解除全部槽位分配，槽位可以分配给其他人；</li>
          <li>暂停所有项目同步，断开开发机连接和网页终端，停止其工作区虚拟机。</li>
        </ul>
        <p>项目、对话、开发机配置和密钥都会保留。恢复后可重新登录，槽位需要重新分配，项目需在工作区点「立即同步」恢复。</p>
      </DangerDialog>
    );
  }
  if (action === "restore") {
    return (
      <DangerDialog title="恢复用户" subtitle={user.username} actionLabel="恢复用户" danger={false} onClose={onClose}
        onConfirm={async () => {
          await post(`/admin/users/${user.id}/restore`);
          await onDone(`已恢复「${user.username}」，请在槽位管理中为其重新分配槽位`);
        }}>
        <p>恢复后该用户可以重新登录，其项目、对话和开发机配置保持停用前的状态。停用时解除的槽位不会自动恢复，需要重新分配。</p>
      </DangerDialog>
    );
  }
  return (
    <DangerDialog title="删除用户" subtitle={user.username} actionLabel="永久删除" confirmText={user.username} onClose={onClose}
      onConfirm={async () => {
        await api(`/admin/users/${user.id}`, { method: "DELETE", body: JSON.stringify({ confirm: user.username }) });
        await onDone(`已删除「${user.username}」及其全部数据`);
      }}>
      <p>删除会先回收该用户的全部资源，再永久删除其数据，无法撤销：</p>
      <ul>
        <li>账号、项目、对话记录、开发机配置、SSH 密钥和用量记录；</li>
        <li>号池机上的项目镜像与备份、原生 CLI 会话历史，以及其工作区虚拟机。</li>
      </ul>
      <p>开发机上的项目文件和本机项目的源码目录不会删除。只想暂时禁止使用时，请改用「停用」。</p>
    </DangerDialog>
  );
}

function UserFieldDialog({ user, action, onClose, onDone }: Props & { action: "rename" | "password" }) {
  const renaming = action === "rename";
  const [value, setValue] = useState(renaming ? user.username : "");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = renaming ? value.trim() : value;
    if (renaming && !usernamePattern.test(next)) {
      setError("用户名需为 3–40 个字符，仅支持字母、数字、下划线、点和连字符。");
      return;
    }
    if (!renaming && (next.length < 12 || next.length > 256)) {
      setError("新密码需为 12–256 个字符。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (renaming) {
        await api(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ username: next }) });
        await onDone(`已将「${user.username}」改名为「${next}」`);
      } else {
        await api(`/admin/users/${user.id}/password`, { method: "PUT", body: JSON.stringify({ password: next }) });
        await onDone(`已重置「${user.username}」的密码，其已登录的设备需要用新密码重新登录`);
      }
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }
  return (
    <Modal title={renaming ? "修改用户名" : "重置密码"} subtitle={user.username} onClose={() => { if (!busy) onClose(); }}>
      <form className="modal-form" onSubmit={submit}>
        {renaming ? (
          <label>
            新用户名
            <input value={value} onChange={(event) => setValue(event.target.value)} disabled={busy}
              autoFocus autoComplete="off" minLength={3} maxLength={40} required />
          </label>
        ) : (
          <>
            <label htmlFor="reset-password">新密码</label>
            <div className="user-password-input">
              <input id="reset-password" type={visible ? "text" : "password"} value={value} disabled={busy}
                onChange={(event) => setValue(event.target.value)} autoFocus autoComplete="new-password"
                placeholder="12–256 个字符" minLength={12} maxLength={256} required />
              <button type="button" className="icon-button" aria-label={visible ? "隐藏新密码" : "显示新密码"}
                aria-pressed={visible} disabled={busy} onClick={() => setVisible(!visible)}>
                {visible ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </>
        )}
        <p className="user-field-hint">
          {renaming
            ? "3–40 个字符，支持中文等字母、数字、下划线、点和连字符。用户之后用新用户名登录，已登录的设备不受影响。"
            : "保存后该用户在所有设备上退出登录，需用新密码重新登录。请通过你信任的方式把新密码交给本人。"}
        </p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button className="button button-primary" disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" />}{renaming ? "保存用户名" : "重置密码"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
