import { useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, Terminal } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { Slot } from "../../types";
import { CopyButton } from "../Dialogs";
import { engineProfiles } from "../../engines";

interface Props {
  slot: Slot;
  disabled: boolean;
  onChanged: (slot: Slot, message: string) => Promise<void>;
}

/** The server prepares the slot's machine first, so the login itself runs where the slot's conversations run. */
function LoginCommand({ slot }: { slot: Slot }) {
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function prepare() {
    setLoading(true);
    setError("");
    try { setCommand((await post<{ command: string }>(`/admin/slots/${encodeURIComponent(slot.id)}/login-command`)).command); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }
  return (
    <>
      <p className="slot-login-note">请先停止使用该槽位的任务，并确认槽位已绑定出口，再以运行服务的系统用户在服务器终端执行。</p>
      {command ? <><pre>{command}</pre><CopyButton value={command} /></> : (
        <button type="button" className="button-secondary" disabled={loading} onClick={() => void prepare()}>
          {loading && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
          {loading ? "正在准备登录环境…" : "生成登录命令"}
        </button>
      )}
      {error && <p className="slot-user-error">{error}</p>}
    </>
  );
}

function SetupToken({ slot, disabled, onChanged }: Props) {
  const [token, setToken] = useState("");
  const [validDays, setValidDays] = useState("365");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const path = `/admin/slots/${encodeURIComponent(slot.id)}/setup-token`;
  async function change(method: "PUT" | "DELETE", message: string) {
    setSaving(true);
    setError("");
    try {
      const updated = await api<Slot>(path, method === "PUT" ? { method, body: JSON.stringify({ token, validDays: Number(validDays) }) } : { method });
      setToken("");
      await onChanged(updated, message);
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change("PUT", slot.auth_method === "token" ? `「${slot.label}」的长期令牌已更换` : `「${slot.label}」已改用长期令牌`);
  }
  return (
    <form className="slot-token-form" onSubmit={save}>
      <p className="slot-login-note">
        在任意装有 Claude Code 的电脑运行 <code>claude setup-token</code>，在浏览器中授权后粘贴输出的令牌。
        长期令牌约一年有效，无法查询额度，也不参与自动选择；改用后槽位中原有的浏览器登录会被删除。
      </p>
      <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off"
        placeholder="sk-ant-oat…" aria-label="长期令牌" disabled={disabled || saving} required />
      <label className="slot-token-validity">
        有效期（天）
        <input type="number" min={1} max={3650} value={validDays} onChange={(event) => setValidDays(event.target.value)}
          disabled={disabled || saving} required />
        <small>setup-token 默认 1 年，CLI 不记录到期时间，按此计算</small>
      </label>
      <div className="slot-token-actions">
        <button className="button-secondary" disabled={disabled || saving || !token.trim()}>
          {saving && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
          {slot.auth_method === "token" ? "更换令牌" : "改用长期令牌"}
        </button>
        {slot.auth_method === "token" && (
          <button type="button" className="button-secondary" disabled={disabled || saving}
            onClick={() => void change("DELETE", `「${slot.label}」已改回浏览器登录，请生成登录命令完成登录`)}>
            改回浏览器登录
          </button>
        )}
      </div>
      {error && <p className="slot-user-error">{error}</p>}
    </form>
  );
}

export default function SlotLogin(props: Props) {
  const { slot } = props;
  const token = slot.auth_method === "token";
  return (
    <details>
      <summary>
        {token ? <KeyRound size={12} /> : <Terminal size={12} />}
        {!engineProfiles[slot.engine].setupToken ? "服务器登录命令" : token ? "登录方式：长期令牌" : "登录方式：浏览器登录"}
      </summary>
      {!token && <LoginCommand slot={slot} />}
      {engineProfiles[slot.engine].setupToken && <SetupToken {...props} />}
    </details>
  );
}
