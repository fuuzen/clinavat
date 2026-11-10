import { useEffect, useState } from "react";
import { LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import { api, errorText, post } from "../../api";
import "../../styles/admin-site.css";

interface HostCommandsStatus {
  user: string;
  address: string;
  port: number;
  ready: boolean;
  checkedAt: string | null;
  error: string | null;
}

/** Local projects' shell commands come back to this host over SSH; the Hub prepares the key and checks the path. */
export default function HostCommands({ execution }: { execution?: "process" | "vm" }) {
  const [status, setStatus] = useState<HostCommandsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (execution !== "vm") return;
    const controller = new AbortController();
    api<HostCommandsStatus | null>("/admin/host-commands", { signal: controller.signal })
      .then(setStatus).catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [execution]);
  async function check() {
    setBusy(true); setError("");
    try { setStatus(await post<HostCommandsStatus>("/admin/host-commands/check")); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const label = !status ? "读取中" : status.ready ? "可用" : status.checkedAt ? "不可用" : "尚未检测";
  return (
    <section className="admin-card admin-site-section" aria-labelledby="admin-host-commands-heading" aria-busy={busy}>
      <div className="admin-card-heading">
        <div><Monitor size={17} /><h3 id="admin-host-commands-heading">本机项目的命令执行</h3></div>
        {execution === "vm" && <span className={`admin-status${status?.ready ? " success" : status?.checkedAt ? " warning" : ""}`}>{label}</span>}
      </div>
      {execution !== "vm" ? (
        <p className="admin-site-description">当前为宿主机执行模式，本机项目的 CLI 和命令都直接在宿主机上运行。</p>
      ) : (
        <>
          <p className="admin-site-description">
            CLI 在所用槽位的虚拟机中运行，账号身份和出口不变；本机项目的 Bash 命令经 SSH 回到宿主机，以运行 Hub 的用户在同一目录中执行。
            Hub 自动维护专用密钥和该用户 <code>~/.ssh/authorized_keys</code> 中的授权（只允许虚拟机网段），sshd 与出站规则在安装时由 <code>deploy/lxd/setup.sh</code> 配置，已有环境运行 <code>deploy/lxd/host-commands.sh apply</code>。
          </p>
          {status && <p className="admin-site-description">
            入口：<code>{status.user}@{status.address}:{status.port}</code>
            {status.checkedAt && <>，上次检测 {new Date(status.checkedAt).toLocaleString()}</>}
          </p>}
          {status?.error && <p className="admin-site-access-error" role="alert">{status.error}</p>}
          {error && <p className="admin-site-access-error" role="alert">{error}</p>}
          <div className="admin-site-access-actions">
            <span>从宿主机登录一次，确认密钥、主机密钥和 sshd 都可用</span>
            <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void check()}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}重新检测
            </button>
          </div>
        </>
      )}
    </section>
  );
}
