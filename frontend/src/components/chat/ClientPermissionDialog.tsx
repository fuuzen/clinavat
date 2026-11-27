import { AlertTriangle } from "lucide-react";
import type { PermissionMode } from "../../types";
import { Modal } from "../Dialogs";
import "../../styles/client-devices.css";

export default function ClientPermissionDialog({
  mode,
  onClose,
  onConfirm,
}: {
  mode: PermissionMode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const modeLabel = mode === "yolo" ? "YOLO（自动批准全部工具）" : "Full access（跳过常规权限确认）";
  return (
    <Modal
      title={`确认切换至 ${mode === "yolo" ? "YOLO" : "Full access"}？`}
      subtitle="桌面客户端项目运行在本机系统环境中，无容器沙箱隔离。"
      onClose={onClose}
    >
      <div className="modal-form">
        <div className="client-risk-box" role="alert">
          <div className="client-risk-heading">
            <AlertTriangle size={16} />
            <span>无沙箱自动执行风险提示</span>
          </div>
          <ul>
            <li>开启 <strong>{modeLabel}</strong> 后，智能体将以本机当前桌面用户权限自动执行命令与文件修改，不再逐项弹窗确认。</li>
            <li>命令可能访问或修改本机 <code>~/.ssh</code>、环境变量、凭据及其他未排除目录。</li>
            <li>建议仅在完全受信任的项目与明确指令下临时使用，完成后切回「自动审批」或「按需审批」。</li>
          </ul>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            保持当前模式
          </button>
          <button type="button" className="button button-danger" onClick={onConfirm}>
            已知悉风险，确认切换
          </button>
        </div>
      </div>
    </Modal>
  );
}
