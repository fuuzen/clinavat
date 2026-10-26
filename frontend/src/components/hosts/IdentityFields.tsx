import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { CopyButton } from "../Dialogs";

export default function IdentityFields({
  name,
  label,
  editing,
  publicKey,
}: {
  name: string;
  label: string;
  editing: boolean;
  publicKey?: string;
}) {
  const [customKey, setCustomKey] = useState(false);
  return (
    <div className="identity-fields">
      <div className="segmented-control" aria-label={`${label}认证方式`}>
        <button type="button" className={!customKey ? "active" : ""} onClick={() => setCustomKey(false)}>
          {editing ? "保留现有密钥" : "平台专属密钥"}
        </button>
        <button type="button" className={customKey ? "active" : ""} onClick={() => setCustomKey(true)}>
          {editing ? "更换私钥" : "导入私钥"}
        </button>
      </div>
      {customKey ? (
        <>
          <label>
            {label}私钥
            <textarea
              name={name}
              className="code-input"
              rows={5}
              placeholder={editing ? "留空保留现有密钥" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
              maxLength={65536}
              required={!editing}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="form-hint">
            <ShieldCheck size={13} />私钥加密存储，仅支持无需口令的密钥。
          </p>
        </>
      ) : editing ? (
        <p className="host-help">不填写新私钥会沿用已保存的密钥；尚未配置时使用平台专属密钥。</p>
      ) : (
        <div className="key-instructions">
          <p>将平台公钥加入{label}的 <code>~/.ssh/authorized_keys</code>。</p>
          {publicKey ? (
            <>
              <pre>{publicKey}</pre>
              <CopyButton value={publicKey} label={`复制${label}公钥`} />
            </>
          ) : <p className="inline-error">用户公钥尚未就绪，请在设置中检查密钥状态。</p>}
        </div>
      )}
    </div>
  );
}
