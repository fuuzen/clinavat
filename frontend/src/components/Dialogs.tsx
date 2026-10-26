import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, LoaderCircle, Sparkles, X } from "lucide-react";
import { api, errorText, post } from "../api";
import type { Overview, Project, Session } from "../types";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function CopyButton({
  value,
  label = "复制",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }
  return (
    <button
      type="button"
      className="button button-ghost"
      onClick={() => void copy()}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "已复制" : failed ? "请手动复制" : label}
    </button>
  );
}

interface CreateProps {
  overview: Overview;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function SessionDialog({
  overview,
  project,
  onClose,
  onCreated,
}: Omit<CreateProps, "onCreated"> & {
  project: Project;
  onCreated: (session: Session) => void;
}) {
  const engines = overview.slot?.cli_types || [];
  const [engine, setEngine] = useState(
    engines.includes("claude") ? "claude" : "codex",
  );
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await post<Session>("/sessions", {
        projectId: project.id,
        engine,
        title: title.trim() || "新对话",
      });
      onCreated(session);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="开启新对话"
      subtitle={`在 ${project.name} 中开始一个独立的任务。`}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <label>
          对话名称
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="你准备完成什么？"
            maxLength={200}
          />
        </label>
        <label>编程智能体</label>
        <div className="engine-choice">
          {(["claude", "codex"] as const).map((value) => (
            <button
              type="button"
              disabled={!engines.includes(value)}
              key={value}
              className={engine === value ? "selected" : ""}
              onClick={() => setEngine(value)}
            >
              <span className={`engine-symbol engine-${value}`}>
                {value === "claude" ? "✳" : "◈"}
              </span>
              <strong>{value === "claude" ? "Claude Code" : "Codex"}</strong>
              <small>
                {engines.includes(value)
                  ? "原生 CLI · 独立上下文"
                  : "当前槽位不可用"}
              </small>
              {engine === value && <Check size={14} />}
            </button>
          ))}
        </div>
        {!overview.slot && (
          <div className="inline-error">请先由管理员分配账号槽位。</div>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button button-primary"
            disabled={
              busy ||
              overview.slot?.status !== "ASSIGNED" ||
              !engines.includes(engine)
            }
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Sparkles size={15} />
            )}
            创建对话
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  name,
  kind,
  onClose,
  onConfirm,
}: {
  name: string;
  kind: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`删除${kind}`} subtitle="请确认此操作。" onClose={onClose}>
      <div className="modal-form">
        <p className="confirm-copy">
          确定删除「<strong>{name}</strong>」吗？
          {kind === "开发机"
            ? "请先删除其下属项目。"
            : kind === "项目"
              ? "项目的同步任务和工作台对话记录将一并移除，远程源代码及原生 CLI 日志保留。"
              : "该对话将从工作台中移除，原生 CLI 日志仍保留在账号槽位中。"}
        </p>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-actions">
          <button
            className="button button-ghost"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            className="button button-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm()
                .then(onClose)
                .catch((cause) => setError(errorText(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {busy && <LoaderCircle size={14} className="spin" />}确认删除
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RenameDialog({
  session,
  onClose,
  onSaved,
}: {
  session: Session;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="重命名对话" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          对话名称
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={200}
          />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-actions">
          <button
            className="button button-ghost"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button button-primary"
            disabled={busy || !title.trim()}
          >
            {busy && <LoaderCircle size={14} className="spin" />}保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
