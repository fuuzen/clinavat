import { useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "../../api";
import { Modal } from "../Dialogs";

/** Confirms an action that is hard to undo; `confirmText`, when given, must be typed before it can proceed. */
export default function DangerDialog({
  title,
  subtitle,
  children,
  actionLabel,
  confirmText,
  danger = true,
  onClose,
  onConfirm,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actionLabel: string;
  confirmText?: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmed = !confirmText || typed === confirmText;
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }
  return (
    <Modal title={title} subtitle={subtitle} onClose={() => { if (!busy) onClose(); }}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (confirmed && !busy) void confirm(); }}>
        <div className="danger-dialog-body">{children}</div>
        {confirmText && (
          <label>
            <span>请输入 <code>{confirmText}</code> 确认</span>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} disabled={busy}
              autoFocus autoComplete="off" spellCheck={false} />
          </label>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button className={`button ${danger ? "button-danger" : "button-primary"}`} disabled={busy || !confirmed}>
            {busy && <LoaderCircle size={14} className="spin" />}{actionLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
