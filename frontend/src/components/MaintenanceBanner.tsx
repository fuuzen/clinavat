import { Wrench } from "lucide-react";
import type { MaintenanceState } from "../types";
import "../styles/maintenance.css";

const DEFAULT_MAINTENANCE_MESSAGE =
  "系统正在维护中，当前为只读模式，所有历史对话仍可正常浏览，暂不支持发起新对话或占用槽位操作。";

interface Props {
  maintenance: MaintenanceState;
}

export default function MaintenanceBanner({ maintenance }: Props) {
  if (!maintenance.enabled) return null;
  const text = maintenance.message?.trim() || DEFAULT_MAINTENANCE_MESSAGE;
  const enabledAt = maintenance.enabledAt
    ? new Date(maintenance.enabledAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="maintenance-banner" role="status" aria-live="polite">
      <span className="maintenance-banner-icon" aria-hidden="true">
        <Wrench size={15} />
      </span>
      <div className="maintenance-banner-body">
        <span className="maintenance-banner-title">维护模式 · 只读</span>
        <span className="maintenance-banner-text">{text}</span>
      </div>
      {enabledAt && <span className="maintenance-banner-meta">开始于 {enabledAt}</span>}
    </div>
  );
}
