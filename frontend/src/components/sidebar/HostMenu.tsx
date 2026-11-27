import { useState } from "react";
import {
  FolderPlus,
  LoaderCircle,
  Pencil,
  TerminalSquare,
  Trash2,
  Unplug,
} from "lucide-react";
import { errorText, post } from "../../api";
import type { DevHost } from "../../types";
import { isClientHost, isClientHostOnline } from "../hosts/client-device";

interface Props {
  host: DevHost;
  maintenanceEnabled: boolean;
  maintenanceTip: string;
  onEditHost: (host: DevHost) => void;
  onConnect: (host: DevHost) => void;
  onNewProject: (host: DevHost) => void;
  onDeleteHost: (host: DevHost) => void;
  onRefresh: () => Promise<void>;
  onNotice?: (message: string, kind?: "error" | "success") => void;
  onClose: () => void;
}

export default function HostMenu({
  host,
  maintenanceEnabled,
  maintenanceTip,
  onEditHost,
  onConnect,
  onNewProject,
  onDeleteHost,
  onRefresh,
  onNotice,
  onClose,
}: Props) {
  const [disconnecting, setDisconnecting] = useState(false);
  const client = isClientHost(host);
  const clientOnline = client && isClientHostOnline(host);

  async function disconnectClient() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await post(`/client-devices/${host.id}/disconnect`);
      await onRefresh();
      onNotice?.(`已断开 ${host.name}`, "success");
      onClose();
    } catch (cause) {
      onNotice?.(errorText(cause));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="context-menu">
      {host.kind !== "local" && !client && (
        <>
          <button
            disabled={maintenanceEnabled}
            title={maintenanceEnabled ? maintenanceTip : undefined}
            onClick={() => {
              onEditHost(host);
              onClose();
            }}
          >
            <Pencil size={14} />
            编辑连接
          </button>
          <button
            disabled={maintenanceEnabled}
            title={maintenanceEnabled ? maintenanceTip : undefined}
            onClick={() => {
              onConnect(host);
              onClose();
            }}
          >
            <TerminalSquare size={14} />
            测试连接
          </button>
        </>
      )}
      {client && (
        <>
          <button
            disabled={maintenanceEnabled}
            title={maintenanceEnabled ? maintenanceTip : undefined}
            onClick={() => {
              onEditHost(host);
              onClose();
            }}
          >
            <Pencil size={14} />
            重命名设备
          </button>
          {clientOnline && (
            <button
              disabled={maintenanceEnabled || disconnecting}
              title={maintenanceEnabled ? maintenanceTip : undefined}
              onClick={() => void disconnectClient()}
            >
              {disconnecting ? <LoaderCircle size={14} className="spin" /> : <Unplug size={14} />}
              {disconnecting ? "正在断开…" : "断开连接"}
            </button>
          )}
        </>
      )}
      <button
        disabled={maintenanceEnabled}
        title={maintenanceEnabled ? maintenanceTip : undefined}
        onClick={() => {
          onNewProject(host);
          onClose();
        }}
      >
        <FolderPlus size={14} />
        创建项目
      </button>
      {host.kind !== "local" && (
        <button
          className="danger-text"
          disabled={maintenanceEnabled}
          title={maintenanceEnabled ? maintenanceTip : undefined}
          onClick={() => {
            onDeleteHost(host);
            onClose();
          }}
        >
          <Trash2 size={14} />
          {client ? "移除设备" : "删除开发机"}
        </button>
      )}
    </div>
  );
}
