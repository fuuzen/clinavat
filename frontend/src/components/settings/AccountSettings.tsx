import {
  ChevronDown,
  CircleUserRound,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { statusLabel } from "../../api";
import type { Overview } from "../../types";
import { CopyButton } from "../Dialogs";

export default function AccountSettings({
  overview,
  onSlots,
}: {
  overview: Overview;
  onSlots: () => void;
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
        <h3>专属账号槽位</h3>
      </div>
      <div className="settings-detail-card">
        {overview.slot ? (
          <>
            <div>
              <strong>{overview.slot.label}</strong>
              <span className="badge badge-green">
                {statusLabel(overview.slot.status)}
              </span>
            </div>
            <p>
              {overview.slot.id} · {overview.slot.cli_types.join(" / ")}
            </p>
            <small>所有对话共享你的专属登录环境，保持项目上下文独立。</small>
          </>
        ) : (
          <>
            <strong>尚未分配账号</strong>
            <p>
              {overview.user.role === "admin"
                ? "在「账号槽位」中创建并绑定账号，即可开始对话。"
                : "联系管理员为你分配账号槽位，即可开始对话。"}
            </p>
            {overview.user.role === "admin" && (
              <button className="text-button" onClick={onSlots}>
                管理账号槽位 <ChevronDown size={13} />
              </button>
            )}
          </>
        )}
      </div>
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
