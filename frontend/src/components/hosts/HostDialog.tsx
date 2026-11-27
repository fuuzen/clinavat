import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Clock, Laptop, LoaderCircle, Plug, Plus, Server } from "lucide-react";
import { api, ApiError, errorText, post } from "../../api";
import { hasClientDeviceIdentity, useClientShell } from "../../client";
import type { DevHost, Overview } from "../../types";
import { Modal } from "../Dialogs";
import ClientDeviceCard from "./ClientDeviceCard";
import { clientPlatformLabel, isClientHost } from "./client-device";
import EndpointFields, { type SshEndpoint } from "./EndpointFields";
import IdentityFields from "./IdentityFields";
import JumpHostFields from "./JumpHostFields";
import { hostPayload } from "./host-form";
import {
  hostConnectionMessage,
  type HostApprovalHint,
  type HostConnection,
} from "./host-connection";

interface Props {
  overview: Overview;
  initialHost?: DevHost;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

type TestResultState =
  | { kind: "success"; message: string }
  | { kind: "pending"; message: string; approval?: HostApprovalHint }
  | { kind: "error"; message: string };

function readApprovalHint(value: unknown): HostApprovalHint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.pinned_ip !== "string" || typeof candidate.port !== "number") return undefined;
  return {
    id: String(candidate.id ?? ""),
    hostname: String(candidate.hostname ?? candidate.pinned_ip),
    pinned_ip: candidate.pinned_ip,
    port: candidate.port,
    status: String(candidate.status ?? "pending"),
    hop: String(candidate.hop ?? "target"),
  };
}

export default function HostDialog({ overview, initialHost, onClose, onCreated }: Props) {
  const shell = useClientShell();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<SshEndpoint>({
    host: initialHost?.host || "", port: initialHost?.port || 22, username: initialHost?.username || "",
  });
  const [jumpEnabled, setJumpEnabled] = useState(Boolean(initialHost?.jump_host));
  const [jump, setJump] = useState<SshEndpoint>({
    host: initialHost?.jump_host || "", port: initialHost?.jump_port || 22, username: initialHost?.jump_username || "",
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResultState | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const editing = Boolean(initialHost);
  const editingClient = isClientHost(initialHost);
  const [clientName, setClientName] = useState(initialHost?.name || "");
  const close = () => { if (!busy) onClose(); };
  useEffect(() => setTestResult(null), [target, jump, jumpEnabled]);
  async function submitClientRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!initialHost || !clientName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/hosts/${initialHost.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: clientName.trim() }),
      });
      await onCreated();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  if (editingClient && initialHost) {
    return (
      <Modal
        title="编辑客户端设备"
        subtitle="连接参数由桌面客户端自动维护，仅支持修改显示名称。"
        onClose={close}
      >
        <form className="modal-form host-form" onSubmit={submitClientRename}>
          <div className="form-section-icon">
            <Laptop size={22} />
            <span>{clientPlatformLabel(initialHost.device?.platform)} · 客户端设备</span>
          </div>
          <label>
            设备名称
            <input
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
              placeholder="例如：我的工作电脑"
              maxLength={100}
              disabled={busy}
              required
              autoFocus
            />
          </label>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="button button-ghost" disabled={busy} onClick={close}>取消</button>
            <button className="button button-primary" disabled={busy || !clientName.trim()}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              保存名称
            </button>
          </div>
        </form>
      </Modal>
    );
  }
  async function testConnection() {
    const form = formRef.current;
    if (!form) return;
    // The name only labels the host, so a connection can be tested before it is filled in.
    const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([name=name]), textarea")];
    if (!fields.every((field) => field.reportValidity())) return;
    const { name, ...body } = hostPayload(form, target, jumpEnabled ? jump : null);
    setTesting(true);
    setTestResult(null);
    try {
      const result = await post<HostConnection>("/hosts/test", { ...body, ...(initialHost ? { hostId: initialHost.id } : {}) });
      if (result.pendingApproval) {
        setTestResult({
          kind: "pending",
          message: result.message || "该内网开发机需要管理员审批后才能连接。",
          approval: result.approval,
        });
      } else {
        setTestResult({ kind: "success", message: hostConnectionMessage(name || "开发机", result) });
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.data?.pendingApproval === true) {
        setTestResult({
          kind: "pending",
          message: cause.message,
          approval: readApprovalHint(cause.data.approval),
        });
      } else {
        setTestResult({ kind: "error", message: errorText(cause) });
      }
    } finally {
      setTesting(false);
    }
  }
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
  const showClientOnboarding = !editing && hasClientDeviceIdentity(shell)
    && !overview.hosts.some((item) => item.kind === "client" && item.device?.id === shell.deviceId);
  return (
    <Modal
      title={editing ? "编辑开发机连接" : "连接开发机"}
      subtitle={editing ? "更新 SSH 连接和跳板机配置。" : "把你的计算环境，带到工作台。"}
      onClose={close}
    >
      {showClientOnboarding && (
        <div className="host-dialog-client-section">
          <ClientDeviceCard
            hosts={overview.hosts}
            onRefresh={onCreated}
            onEnabled={onClose}
          />
        </div>
      )}
      <form ref={formRef} className="modal-form host-form" onSubmit={submit}>
        <fieldset className="host-fields" disabled={busy || testing}>
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
        {testResult && (
          testResult.kind === "pending" ? (
            <div className="connection-test-result connection-test-pending" role="status">
              <Clock size={15} />
              <div className="connection-test-pending-body">
                <strong>等待管理员审批</strong>
                <p>{testResult.message}</p>
                {testResult.approval && (
                  <p className="connection-test-pending-target">
                    目标（{testResult.approval.hop === "jump" ? "跳板机" : "开发机"}）：
                    {testResult.approval.hostname !== testResult.approval.pinned_ip
                      ? `${testResult.approval.hostname} → `
                      : ""}
                    <code>{testResult.approval.pinned_ip}:{testResult.approval.port}</code>
                  </p>
                )}
                <p className="connection-test-pending-hint">
                  审批请求已提交，管理员批准后即可重新点击「测试连接」。
                </p>
              </div>
            </div>
          ) : (
            <div
              className={testResult.kind === "success" ? "connection-test-result success-note" : "connection-test-result inline-error"}
              role={testResult.kind === "success" ? "status" : "alert"}
            >
              {testResult.message}
            </div>
          )
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost modal-action-start" disabled={busy || testing} onClick={() => void testConnection()}>
            {testing ? <LoaderCircle className="spin" size={15} /> : <Plug size={15} />}
            {testing ? "正在测试…" : "测试连接"}
          </button>
          <button type="button" className="button button-ghost" disabled={busy} onClick={close}>取消</button>
          <button className="button button-primary" disabled={busy || testing}>
            {busy ? <LoaderCircle className="spin" size={15} /> : editing ? <Check size={15} /> : <Plus size={15} />}
            {editing ? "保存连接" : "添加开发机"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
