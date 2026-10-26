import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { api, errorText } from "../../api";

export default function ServiceStatus() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setHealth(await api<Record<string, unknown>>("/health"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <>
        <div className="settings-section-heading">
          <Server size={18} />
          <h3>服务状态</h3>
          <button
            className="icon-button"
            onClick={() => void load()}
            disabled={busy}
            aria-label="刷新服务状态"
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
          </button>
        </div>
        <p className="settings-description">
          查看控制面与 CLI 运行环境。开发机连通性请在侧栏对应节点中测试。
        </p>
        {busy && !health ? (
          <div className="loading-state">
            <LoaderCircle size={20} className="spin" />
          </div>
        ) : (
          health && (
            <div className="health-result">
              {Object.entries(health).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  {typeof value === "object" ? (
                    <pre>{JSON.stringify(value, null, 2)}</pre>
                  ) : (
                    <strong
                      className={
                        value === true || value === "ok" ? "positive-text" : ""
                      }
                    >
                      {typeof value === "boolean"
                        ? value
                          ? "可用"
                          : "不可用"
                        : String(value)}
                    </strong>
                  )}
                </div>
              ))}
            </div>
          )
        )}
        <div className="info-note">
          <ShieldCheck size={16} />
          <p>
            官方 CLI 的 OAuth
            凭据仅在对应槽位内使用。网页不会读取或展示访问令牌。
          </p>
        </div>
      </>
    </>
  );
}
