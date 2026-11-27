import { useState } from "react";
import { Pencil, Plus, RefreshCw, Server, ShieldAlert, Trash2, Unplug, X } from "lucide-react";
import { hubKeyFromUrl, type Hub, type HubBook } from "./hubs";
import type { DaemonBridgeSnapshot, HubDaemonStatus, PendingFingerprintInfo } from "./native";

interface Props {
  book: HubBook;
  daemon: DaemonBridgeSnapshot | null;
  daemonBusyKey: string | null;
  onOpen: (hub: Hub) => void;
  onAdd: () => void;
  onEdit: (hub: Hub) => void;
  onRemove: (hub: Hub) => void;
  onLaunchChange: (openLastOnLaunch: boolean) => void;
  onToggleDaemon: (hub: Hub, enabled: boolean) => void;
  onReconnectDaemon: (hub: Hub) => void;
  onDisconnectDaemon: (hub: Hub) => void;
  onReviewFingerprint: (pending: PendingFingerprintInfo) => void;
}

function statusBadge(state?: HubDaemonStatus) {
  if (!state || state.status === "stopped") return { label: "未连接", className: "badge" };
  switch (state.status) {
    case "connected":
      return { label: "已连接", className: "badge badge-green" };
    case "awaiting_fingerprint":
      return { label: "待确认指纹", className: "badge badge-danger" };
    case "error":
      return { label: "连接异常", className: "badge badge-danger" };
    case "bootstrapping":
    case "connecting":
      return { label: "连接中", className: "badge badge-info" };
    case "unregistered":
      return { label: "未在 Hub 启用", className: "badge badge-amber" };
    case "reconnecting":
      return { label: `重连中 #${state.reconnectAttempt ?? 1}`, className: "badge badge-amber" };
    case "maintenance":
      return { label: "维护中", className: "badge badge-amber" };
    case "suspended":
      return { label: "账号已停用", className: "badge badge-danger" };
  }
}

function transportLabel(transport?: string) {
  if (!transport) return null;
  const upper = transport.toUpperCase();
  return upper === "WS" ? "WS" : upper;
}

export default function HubList({
  book,
  daemon,
  daemonBusyKey,
  onOpen,
  onAdd,
  onEdit,
  onRemove,
  onLaunchChange,
  onToggleDaemon,
  onReconnectDaemon,
  onDisconnectDaemon,
  onReviewFingerprint,
}: Props) {
  const [removing, setRemoving] = useState<string | null>(null);
  const statusByKey = new Map((daemon?.hubs ?? []).map((item) => [item.hubKey, item]));

  return (
    <>
      <ul className="hub-list">
        {book.hubs.map((hub) => {
          const hubKey = hubKeyFromUrl(hub.url);
          const dState = statusByKey.get(hubKey);
          const enabled = Boolean(dState?.enabled);
          const active = enabled || (dState !== undefined && dState.status !== "stopped");
          const busy = daemonBusyKey === hubKey || daemonBusyKey === "*";
          const badge = statusBadge(dState);
          const transport = dState?.status === "connected" ? transportLabel(dState.transport) : null;

          return (
            <li key={hub.id} className="hub-item">
              <div className="hub-item-main">
                <button className="hub-open" onClick={() => onOpen(hub)}>
                  <Server size={18} />
                  <span className="hub-label">
                    <strong>{hub.name}</strong>
                    <small>{hub.url}</small>
                  </span>
                  {hub.url.startsWith("http:") && <span className="badge badge-amber">未加密</span>}
                  {hub.id === book.lastHubId && <span className="badge">上次使用</span>}
                </button>
                {removing === hub.id ? (
                  <>
                    <button className="button button-danger button-small" onClick={() => onRemove(hub)}>删除</button>
                    <button className="icon-button" onClick={() => setRemoving(null)} title="保留" aria-label="保留">
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className="icon-button" onClick={() => onEdit(hub)} title="编辑" aria-label={`编辑 ${hub.name}`}>
                      <Pencil size={15} />
                    </button>
                    <button className="icon-button" onClick={() => setRemoving(hub.id)} title="删除" aria-label={`删除 ${hub.name}`}>
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>

              {daemon?.supported && (
                <div className="hub-daemon-row">
                  <div className="hub-daemon-left">
                    <label className="daemon-switch">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={busy || Boolean(daemon.initError)}
                        onChange={(event) => onToggleDaemon(hub, event.target.checked)}
                      />
                      <span>此电脑守护进程</span>
                    </label>
                    <span className={badge.className}>{badge.label}</span>
                    {transport && <span className="badge badge-info">{transport}</span>}
                  </div>
                  <div className="hub-daemon-actions">
                    {dState?.status === "awaiting_fingerprint" && dState.pendingFingerprint && (
                      <button
                        type="button"
                        className="button button-danger button-small"
                        disabled={busy}
                        onClick={() => onReviewFingerprint(dState.pendingFingerprint!)}
                      >
                        <ShieldAlert size={13} />
                        核对指纹
                      </button>
                    )}
                    {(enabled || dState?.lastError) && (
                      <button
                        type="button"
                        className="button button-ghost button-small"
                        disabled={busy || Boolean(daemon.initError)}
                        onClick={() => onReconnectDaemon(hub)}
                      >
                        <RefreshCw size={13} />
                        重连
                      </button>
                    )}
                    {active && (
                      <button
                        type="button"
                        className="button button-danger button-small"
                        disabled={busy}
                        onClick={() => onDisconnectDaemon(hub)}
                      >
                        <Unplug size={13} />
                        断开
                      </button>
                    )}
                  </div>
                  {dState?.status === "unregistered" && (
                    <p className="hub-daemon-note">打开此 Hub 并在工作台启用「此电脑」后，将自动建立连接。</p>
                  )}
                  {dState?.lastError && dState.status !== "connected" && (
                    <p className="hub-daemon-error">{dState.lastError}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button className="button button-ghost hub-add" onClick={onAdd}>
        <Plus size={16} />
        添加 Hub
      </button>
      <label className="hub-launch">
        <input type="checkbox" checked={book.openLastOnLaunch} onChange={(event) => onLaunchChange(event.target.checked)} />
        启动时自动打开上次使用的 Hub
      </label>
    </>
  );
}
