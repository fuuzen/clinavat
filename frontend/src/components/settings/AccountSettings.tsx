import {
  CircleUserRound,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { statusLabel } from "../../api";
import type { Overview } from "../../types";
import { CopyButton } from "../Dialogs";

export default function AccountSettings({
  overview,
}: {
  overview: Overview;
}) {
  return (
    <>
      <div className="settings-section-heading">
        <CircleUserRound size={18} />
        <h3>个人账号</h3>
      </div>
      <div className="account-card">
        <span className="avatar avatar-large">
          {overview.user.username.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <strong>{overview.user.username}</strong>
          <span>{overview.user.role === "admin" ? "管理员" : "成员"}</span>
        </div>
        <span className="badge">独立工作空间</span>
      </div>
      <div className="settings-section-heading">
        <ShieldCheck size={17} />
        <h3>获授权的账号槽位</h3>
      </div>
      {overview.slots.length ? overview.slots.map((slot) => (
        <div className="settings-detail-card" key={slot.id}>
          <div>
            <strong>{slot.label}</strong>
            <span className={`badge ${slot.status === "IDLE" ? "badge-green" : ""}`}>
              {slot.status === "IDLE" ? slot.in_use ? slot.in_use_by_you ? "你正在使用" : "其他用户使用中" : "可用" : statusLabel(slot.status)}
            </span>
          </div>
          <p>{slot.id} · {slot.engine === "claude" ? "Claude Code" : "Codex"}</p>
          <small>不同对话可同时使用不同槽位，切换仅影响当前对话；此槽位同时限 1 位用户。</small>
        </div>
      )) : (
        <div className="settings-detail-card">
          <strong>尚无账号授权</strong>
          <p>联系管理员开放槽位访问权限后，即可在对话中选择账号。</p>
        </div>
      )}
      <div className="settings-section-heading">
        <KeyRound size={17} />
        <h3>SSH 专属公钥</h3>
      </div>
      <p className="settings-description">
        将此公钥加入远程开发机的 <code>~/.ssh/authorized_keys</code>
        ，允许工作台安全连接。
      </p>
      {overview.user.ssh_public_key ? (
        <div className="settings-key">
          <pre>{overview.user.ssh_public_key}</pre>
          <CopyButton value={overview.user.ssh_public_key} label="复制公钥" />
        </div>
      ) : (
        <p className="inline-error">公钥未就绪，请检查服务端用户密钥配置。</p>
      )}
    </>
  );
}
