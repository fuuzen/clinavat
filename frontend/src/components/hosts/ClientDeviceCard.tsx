import { useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Laptop,
  LoaderCircle,
  Pencil,
  PlugZap,
  Trash2,
  Unplug,
  WifiOff,
} from "lucide-react";
import { api, errorText, post } from "../../api";
import { hasClientDeviceIdentity, useClientShell, type ClientDeviceShell } from "../../client";
import type { DevHost } from "../../types";
import { ConfirmDialog, Modal } from "../Dialogs";
import {
  clientPlatformLabel,
  formatClientLastSeen,
  isClientHostOnline,
  normalizeClientPlatform,
} from "./client-device";
import "../../styles/client-devices.css";

export interface ClientDeviceCardProps {
  /** Existing client host to manage; omit to offer enabling the active desktop client. */
  host?: DevHost;
  /** Used when `host` is omitted to hide the onboarding card once this computer is registered. */
  hosts?: DevHost[];
  projectCount?: number;
  variant?: "card" | "compact" | "banner";
  readOnly?: boolean;
  readOnlyReason?: string;
  onRefresh: () => Promise<void>;
  onNotice?: (message: string, kind?: "error" | "success") => void;
  onEnabled?: () => void;
}

function defaultDeviceLabel(shell: ClientDeviceShell): string {
  return shell.deviceName?.trim() || `${clientPlatformLabel(shell.platform)} 设备`;
}

function RegisterConfirmModal({
  shell,
  onClose,
  onConfirmed,
}: {
  shell: ClientDeviceShell;
  onClose: () => void;
  onConfirmed: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(() => defaultDeviceLabel(shell));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      await onConfirmed(trimmed);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="启用此电脑为开发机"
      subtitle="确认后，工作台将通过桌面客户端直接访问本机目录与终端。"
      onClose={() => { if (!busy) onClose(); }}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="client-risk-box" role="alert">
          <div className="client-risk-heading">
            <AlertTriangle size={16} />
            <span>安全风险提示（无容器沙箱隔离）</span>
          </div>
          <ul>
            <li>命令与文件操作将在本机以当前桌面用户系统权限直接执行，无容器沙箱隔离。</li>
            <li>智能体可读取本机 <code>~/.ssh</code>、环境变量、个人凭据及其他未排除的本地数据。</li>
            <li>建议默认关闭 YOLO / Full access 自动授权，仅在受信任项目中按需授权。</li>
          </ul>
        </div>
        <label>
          开发机显示名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：我的工作电脑"
            maxLength={100}
            disabled={busy}
            required
          />
        </label>
        <p className="form-hint">
          平台：{clientPlatformLabel(shell.platform)}
          {shell.arch ? ` · ${shell.arch}` : ""}
          {shell.defaultShell ? ` · ${shell.defaultShell}` : ""}
        </p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button button-primary" disabled={busy || !name.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />}
            已知悉风险，确认启用
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameClientHostModal({
  host,
  onClose,
  onSaved,
}: {
  host: DevHost;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(host.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      await api(`/hosts/${host.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <Modal title="重命名客户端设备" subtitle="连接参数由桌面客户端自动维护，仅修改显示名称。" onClose={() => { if (!busy) onClose(); }}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          设备名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            disabled={busy}
            required
          />
        </label>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button button-primary" disabled={busy || !name.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />}保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ClientDeviceCard({
  host,
  hosts,
  projectCount,
  variant = "card",
  readOnly = false,
  readOnlyReason,
  onRefresh,
  onNotice,
  onEnabled,
}: ClientDeviceCardProps) {
  const shell = useClientShell();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");

  if (!host) {
    if (!hasClientDeviceIdentity(shell)) return null;
    if (hosts?.some((item) => item.kind === "client" && item.device?.id === shell.deviceId)) return null;
    const platformLabel = clientPlatformLabel(shell.platform);
    const displayName = defaultDeviceLabel(shell);

    async function registerDevice(chosenName: string) {
      if (!hasClientDeviceIdentity(shell)) return;
      await post("/client-devices/register", {
        deviceId: shell.deviceId,
        publicKey: shell.publicKey,
        name: chosenName,
        platform: normalizeClientPlatform(shell.platform),
        arch: shell.arch?.trim() || "unknown",
        osVersion: shell.osVersion?.trim() || "",
        defaultShell: shell.defaultShell?.trim() || "",
        homedir: shell.homedir?.trim() || "",
      });
      await onRefresh();
      onNotice?.(`已启用「${chosenName}」为开发机`, "success");
      onEnabled?.();
    }

    return (
      <>
        <article className={`client-device-card is-promo${variant === "compact" ? " is-compact" : variant === "banner" ? " is-banner" : ""}`}>
          <div className="client-device-head">
            <span className="client-device-icon"><Laptop size={variant === "compact" ? 15 : 19} /></span>
            <div className="client-device-title">
              <div className="client-device-title-row">
                <strong>此电脑（{displayName} · {platformLabel}）</strong>
              </div>
              <span>
                {[shell.arch, shell.osVersion, shell.defaultShell].filter(Boolean).join(" · ") || "桌面客户端本机开发机"}
              </span>
            </div>
          </div>
          {variant !== "compact" && (
            <p className="client-device-copy">
              无需配置 SSH 密钥与公网端口，直接将当前电脑接入工作台，支持本机直执或镜像同步模式。
            </p>
          )}
          <div className="client-device-actions">
            <button
              type="button"
              className="button button-primary button-small"
              disabled={readOnly}
              title={readOnly ? readOnlyReason : undefined}
              onClick={() => setRegisterOpen(true)}
            >
              <PlugZap size={14} />启用为开发机
            </button>
          </div>
        </article>
        {registerOpen && (
          <RegisterConfirmModal
            shell={shell}
            onClose={() => setRegisterOpen(false)}
            onConfirmed={registerDevice}
          />
        )}
      </>
    );
  }

  const online = isClientHostOnline(host);
  const device = host.device;
  const platformLabel = clientPlatformLabel(device?.platform);
  const isCurrentDevice = Boolean(shell?.deviceId && device?.id === shell.deviceId);

  async function disconnect() {
    if (!host || disconnecting || readOnly) return;
    setDisconnecting(true);
    setError("");
    try {
      await post(`/client-devices/${host.id}/disconnect`);
      await onRefresh();
      onNotice?.(`已断开 ${host.name}`, "success");
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      onNotice?.(message);
    } finally {
      setDisconnecting(false);
    }
  }

  async function removeDevice() {
    if (!host) return;
    await api(`/hosts/${host.id}`, { method: "DELETE" });
    await onRefresh();
    onNotice?.(`已移除设备「${host.name}」`, "success");
  }

  return (
    <>
      <article className="client-device-card">
        <div className="client-device-head">
          <span className="client-device-icon"><Laptop size={19} /></span>
          <div className="client-device-title">
            <div className="client-device-title-row">
              <strong>{host.name}</strong>
              {isCurrentDevice && <span className="client-device-tag">此电脑</span>}
            </div>
            <span>{platformLabel} · 客户端设备</span>
          </div>
          <span className={`client-device-status${online ? " online" : ""}`}>
            <i aria-hidden="true" />
            {online ? "已连接" : "未连接"}
          </span>
        </div>

        <dl className="client-device-meta">
          <div>
            <dt>平台与架构</dt>
            <dd>{platformLabel}{device?.arch ? ` · ${device.arch}` : ""}</dd>
          </div>
          <div>
            <dt>默认 Shell</dt>
            <dd><code>{device?.default_shell || "—"}</code></dd>
          </div>
          {device?.os_version && (
            <div>
              <dt>系统版本</dt>
              <dd>{device.os_version}</dd>
            </div>
          )}
          {device?.homedir && (
            <div>
              <dt>主目录</dt>
              <dd><code>{device.homedir}</code></dd>
            </div>
          )}
          <div>
            <dt>最近活跃</dt>
            <dd>{formatClientLastSeen(device?.last_seen_at)}</dd>
          </div>
          {projectCount !== undefined && (
            <div>
              <dt>关联项目</dt>
              <dd>{projectCount} 个 Workspace</dd>
            </div>
          )}
        </dl>

        {!online && (
          <div className="client-device-offline-hint" role="status">
            <WifiOff size={14} />
            <span>客户端离线，请在桌面客户端确认连接。</span>
          </div>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}

        <div className="client-device-actions">
          {online && (
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={disconnecting || readOnly}
              title={readOnly ? readOnlyReason : undefined}
              onClick={() => void disconnect()}
            >
              {disconnecting ? <LoaderCircle size={13} className="spin" /> : <Unplug size={13} />}
              {disconnecting ? "正在断开…" : "断开连接"}
            </button>
          )}
          <button
            type="button"
            className="button button-secondary button-small"
            disabled={readOnly}
            title={readOnly ? readOnlyReason : undefined}
            onClick={() => setRenameOpen(true)}
          >
            <Pencil size={13} />重命名
          </button>
          <button
            type="button"
            className="button button-ghost button-small danger-text"
            disabled={readOnly}
            title={readOnly ? readOnlyReason : undefined}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={13} />移除设备
          </button>
        </div>
      </article>

      {renameOpen && (
        <RenameClientHostModal
          host={host}
          onClose={() => setRenameOpen(false)}
          onSaved={async () => {
            await onRefresh();
            onNotice?.("设备名称已更新", "success");
          }}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          name={host.name}
          kind="开发机"
          onClose={() => setDeleteOpen(false)}
          onConfirm={removeDevice}
        />
      )}
    </>
  );
}
