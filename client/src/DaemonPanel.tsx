import { useState } from "react";
import { AlertTriangle, Check, Copy, Laptop, Unplug } from "lucide-react";
import type { DaemonBridgeSnapshot } from "./native";

interface Props {
  snapshot: DaemonBridgeSnapshot;
  busy: boolean;
  onDisconnectAll: () => void;
}

function platformLabel(platform: string) {
  const value = platform.toLowerCase();
  if (value === "macos" || value === "darwin") return "macOS";
  if (value === "windows" || value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return platform;
}

export default function DaemonPanel({ snapshot, busy, onDisconnectAll }: Props) {
  const [copied, setCopied] = useState(false);

  if (!snapshot.supported) return null;

  const activeCount = snapshot.hubs.filter((item) => item.enabled || item.status !== "stopped").length;
  const connectedCount = snapshot.hubs.filter((item) => item.status === "connected").length;
  const metaParts = [platformLabel(snapshot.platform), snapshot.arch, snapshot.defaultShell].filter(Boolean);

  async function copyPublicKey() {
    if (!snapshot.publicKey) return;
    try {
      await navigator.clipboard.writeText(snapshot.publicKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="daemon-panel" aria-label="此电脑开发机守护进程">
      <div className="daemon-head">
        <div className="daemon-title">
          <Laptop size={18} />
          <div>
            <strong>{snapshot.deviceName || "此电脑"}</strong>
            <span>{metaParts.join(" · ")}</span>
          </div>
        </div>
        <div className="daemon-head-actions">
          {connectedCount > 0 ? (
            <span className="badge badge-green">已连接 {connectedCount} 个 Hub</span>
          ) : (
            <span className="badge">守护进程待命</span>
          )}
          {activeCount > 0 && (
            <button
              type="button"
              className="button button-danger button-small"
              disabled={busy}
              onClick={onDisconnectAll}
            >
              <Unplug size={13} />
              一键断开全部
            </button>
          )}
        </div>
      </div>

      {snapshot.initError && (
        <div className="inline-error" role="alert">
          守护进程初始化失败：{snapshot.initError}
        </div>
      )}

      {snapshot.configError && (
        <div className="inline-error" role="alert">
          {snapshot.configError}
        </div>
      )}

      {snapshot.publicKey && (
        <div className="daemon-key-block">
          <div className="daemon-key-header">
            <span>本机 Ed25519 公钥</span>
            <button type="button" className="button button-ghost button-small" onClick={() => void copyPublicKey()}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制公钥"}
            </button>
          </div>
          <code className="daemon-key-code">{snapshot.publicKey}</code>
        </div>
      )}

      <div className="daemon-risk-notice" role="note">
        <AlertTriangle size={15} />
        <p>
          <strong>安全风险提示：</strong>
          启用「此电脑」守护进程后，来自已授权 Hub 的命令与文件操作会以当前本机用户权限直接执行（无容器沙箱隔离），可能访问本机目录、
          <code>~/.ssh</code> 与环境变量。建议使用专用系统账号，并在不需要时随时一键断开。
        </p>
      </div>
    </section>
  );
}
