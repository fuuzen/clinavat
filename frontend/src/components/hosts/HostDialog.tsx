import { useState, type FormEvent } from "react";
import { Check, LoaderCircle, Plus, Server } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { DevHost, Overview } from "../../types";
import { Modal } from "../Dialogs";
import EndpointFields, { type SshEndpoint } from "./EndpointFields";
import IdentityFields from "./IdentityFields";
import JumpHostFields from "./JumpHostFields";
import { hostPayload } from "./host-form";

interface Props {
  overview: Overview;
  initialHost?: DevHost;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export default function HostDialog({ overview, initialHost, onClose, onCreated }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<SshEndpoint>({
    host: initialHost?.host || "", port: initialHost?.port || 22, username: initialHost?.username || "",
  });
  const [jumpEnabled, setJumpEnabled] = useState(Boolean(initialHost?.jump_host));
  const [jump, setJump] = useState<SshEndpoint>({
    host: initialHost?.jump_host || "", port: initialHost?.jump_port || 22, username: initialHost?.jump_username || "",
  });
  const editing = Boolean(initialHost);
  const close = () => { if (!busy) onClose(); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = hostPayload(event.currentTarget, target, jumpEnabled ? jump : null);
    setBusy(true);
    setError("");
    try {
      if (initialHost) await api(`/hosts/${initialHost.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await post("/hosts", body);
      await onCreated();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={editing ? "编辑开发机连接" : "连接开发机"}
      subtitle={editing ? "更新 SSH 连接和跳板机配置。" : "把你的计算环境，带到工作台。"}
      onClose={close}
    >
      <form className="modal-form host-form" onSubmit={submit}>
        <fieldset className="host-fields" disabled={busy}>
          <div className="form-section-icon"><Server size={22} /><span>SSH 远程连接</span></div>
          <label>
            开发机名称
            <input name="name" defaultValue={initialHost?.name || ""} placeholder="例如：我的开发工作站" maxLength={100} required autoFocus />
          </label>
          <EndpointFields value={target} onChange={setTarget} />
          <IdentityFields name="privateKey" label="开发机" editing={editing} publicKey={overview.user.ssh_public_key} />
          <JumpHostFields
            enabled={jumpEnabled} onEnabledChange={setJumpEnabled}
            value={jump} onChange={setJump} target={target}
            editing={editing} publicKey={overview.user.ssh_public_key}
          />
          {editing && <p className="host-help">更改连接后，需重新测试连接并恢复项目同步；运行中的任务需先停止。</p>}
        </fieldset>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={close}>取消</button>
          <button className="button button-primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : editing ? <Check size={15} /> : <Plus size={15} />}
            {editing ? "保存连接" : "添加开发机"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
