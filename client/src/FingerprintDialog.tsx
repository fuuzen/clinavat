import { useState } from "react";
import { AlertTriangle, Check, Copy, LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import type { PendingFingerprintInfo } from "./native";

interface Props {
  pending: PendingFingerprintInfo;
  busy: boolean;
  error: string;
  onConfirm: (hubUrl: string, fingerprint: string) => void;
  onReject: (hubUrl: string) => void;
}

export default function FingerprintDialog({ pending, busy, error, onConfirm, onReject }: Props) {
  const [copied, setCopied] = useState(false);
  const isChanged = pending.reason === "changed";

  async function copyFingerprint() {
    try {
      await navigator.clipboard.writeText(pending.hostKeyFingerprint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fp-overlay" role="dialog" aria-modal="true" aria-labelledby="fp-dialog-title">
      <div className={`fp-dialog${isChanged ? " is-danger" : ""}`}>
        <div className="fp-header">
          <span className={`fp-icon${isChanged ? " is-danger" : ""}`}>
            {isChanged ? <ShieldAlert size={20} /> : <AlertTriangle size={20} />}
          </span>
          <div>
            <h2 id="fp-dialog-title">
              {isChanged ? "高危警告：Hub 主机指纹已变更" : "确认非加密 HTTP Hub 主机指纹"}
            </h2>
            <p className="fp-subtitle">
              {pending.hubUrl}（主机：{pending.host}）
            </p>
          </div>
        </div>

        <div className={`fp-alert${isChanged ? " is-danger" : ""}`} role="alert">
          {isChanged ? (
            <p>
              已信任 Hub 的 SSH 主机密钥指纹与历史记录不一致。这可能是 Hub 重新生成了主机密钥，也可能是中间人攻击。
              <strong>在通过可信渠道核实新指纹前，请勿确认信任。</strong>
            </p>
          ) : (
            <p>
              正在首次通过非回环明文 <code>http://</code> 连接此 Hub。由于没有 HTTPS 证书校验，请通过 Hub 管理台或终端日志人工核对以下 SHA-256 主机指纹后再决定是否信任。
            </p>
          )}
        </div>

        {isChanged && pending.expectedFingerprint && (
          <div className="fp-field">
            <span className="fp-field-label">原已信任指纹</span>
            <code className="fp-code is-muted">{pending.expectedFingerprint}</code>
          </div>
        )}

        <div className="fp-field">
          <div className="fp-field-head">
            <span className="fp-field-label">{isChanged ? "当前收到的新指纹" : "Hub SSH 主机密钥指纹（SHA-256）"}</span>
            <button type="button" className="button button-ghost button-small" onClick={() => void copyFingerprint()}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <code className="fp-code">{pending.hostKeyFingerprint}</code>
        </div>

        {error && <div className="inline-error" role="alert">{error}</div>}

        <div className="fp-actions">
          <button
            type="button"
            className="button button-danger"
            disabled={busy}
            onClick={() => onReject(pending.hubUrl)}
          >
            拒绝并断开
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => onConfirm(pending.hubUrl, pending.hostKeyFingerprint)}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}
            {isChanged ? "我已核实，信任新指纹" : "确认信任并连接"}
          </button>
        </div>
      </div>
    </div>
  );
}
