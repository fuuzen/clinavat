import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { api, errorText, post } from "../../api";
import type {
  DevHostApprovalsResponse,
  DevHostApprovalStatus,
  DevHostApprovalView,
  DevHostRelayStatus,
} from "./types";

type StatusFilter = "all" | "pending" | "approved" | "closed";

const filterOptions: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待审批" },
  { id: "approved", label: "已批准" },
  { id: "closed", label: "已拒绝或撤销" },
];

const statusMeta: Record<DevHostApprovalStatus, { label: string; tone: string }> = {
  pending: { label: "待审批", tone: "warning" },
  approved: { label: "已批准", tone: "success" },
  rejected: { label: "已拒绝", tone: "danger" },
  revoked: { label: "已撤销", tone: "danger" },
};

function formatDateTime(timestamp: string | null): string {
  if (!timestamp) return "—";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(timestamp)
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString("zh-CN");
}

function matchesFilter(status: DevHostApprovalStatus, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "closed") return status === "rejected" || status === "revoked";
  return status === filter;
}

export default function DevHostApprovals() {
  const [approvals, setApprovals] = useState<DevHostApprovalView[]>([]);
  const [relay, setRelay] = useState<DevHostRelayStatus | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<DevHostApprovalsResponse>("/admin/dev-host-approvals");
      setApprovals(data.approvals);
      setRelay(data.relay);
    } catch (cause) {
      setError(`读取内网开发机审批失败：${errorText(cause)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: DevHostApprovalView, action: "approve" | "reject" | "revoke") {
    if (busyId) return;
    const userLabel = item.username || item.user_id;
    const targetLabel = `${item.pinned_ip}:${item.port}`;
    if (
      action === "revoke" &&
      !window.confirm(
        `撤销 ${userLabel} 对 ${targetLabel} 的内网访问授权？撤销后会立即断开该目标的活跃中继隧道。`,
      )
    ) {
      return;
    }

    setBusyId(item.id);
    setError("");
    setMessage("");
    try {
      if (action === "approve") {
        await post<{ approval: DevHostApprovalView }>(
          `/admin/dev-host-approvals/${item.id}/approve`,
          {},
        );
        setMessage(`已批准 ${userLabel} 访问 ${targetLabel}。`);
      } else {
        const result = await post<{ approval: DevHostApprovalView; disconnected: number }>(
          `/admin/dev-host-approvals/${item.id}/${action}`,
          {},
        );
        const verb = action === "revoke" ? "已撤销" : "已拒绝";
        setMessage(
          result.disconnected > 0
            ? `${verb} ${userLabel} 对 ${targetLabel} 的访问，并断开 ${result.disconnected} 条活跃连接。`
            : `${verb} ${userLabel} 对 ${targetLabel} 的访问。`,
        );
      }
      await load();
    } catch (cause) {
      setError(`操作失败：${errorText(cause)}`);
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = approvals.filter((item) => item.status === "pending").length;
  const visible = approvals.filter((item) => matchesFilter(item.status, filter));

  return (
    <section className="admin-card gateway-section" aria-busy={loading || !!busyId}>
      <div className="admin-card-heading">
        <div>
          <ShieldAlert size={16} />
          <h3>内网开发机审批</h3>
        </div>
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={() => void load()}
          disabled={loading || !!busyId}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />刷新
        </button>
      </div>
      <p className="gateway-description">
        虚拟机与工作区访问私网开发机首跳时，统一经宿主机 Hub 单端口中继按用户与钉住 IP 审批放行；未配置上游网关或网关离线时也可直接审批。
      </p>

      <div className="dev-approvals-bar">
        <div className="dev-approvals-relay">
          {relay ? (
            <>
              <span className={`admin-status ${relay.enabled ? "success" : "warning"}`}>
                {relay.enabled ? "中继运行中" : "中继未启用"}
              </span>
              <span className="admin-status">监听端口 {relay.port}</span>
              <span className="admin-status">活跃隧道 {relay.activeConnections}</span>
            </>
          ) : (
            <span className="admin-status">{loading ? "正在读取中继状态…" : "中继状态未知"}</span>
          )}
          {pendingCount > 0 && <span className="admin-status warning">待审批 {pendingCount}</span>}
        </div>
        <div className="dev-approvals-filters" role="group" aria-label="按审批状态筛选">
          {filterOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`dev-approvals-filter${filter === option.id ? " active" : ""}`}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
              {option.id === "pending" && pendingCount > 0 ? ` (${pendingCount})` : ""}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="inline-error dev-approvals-feedback" role="alert">{error}</div>}
      {message && (
        <p className="gateway-message dev-approvals-feedback" role="status">
          <Check size={13} />
          {message}
        </p>
      )}

      {loading && approvals.length === 0 ? (
        <p className="gateway-hint">正在加载审批列表…</p>
      ) : visible.length === 0 ? (
        <p className="gateway-hint">当前筛选下暂无内网开发机审批记录。</p>
      ) : (
        <div className="dev-approvals-list">
          {visible.map((item) => {
            const meta = statusMeta[item.status];
            const isBusy = busyId === item.id;
            const endpointDiffers = item.hostname && item.hostname !== item.pinned_ip;
            const decider = item.decided_by_username || item.decided_by;
            return (
              <div key={item.id} className="gateway-row dev-approval-row">
                <div className="dev-approval-main">
                  <div className="dev-approval-header">
                    <strong>{item.username || item.user_id}</strong>
                    <span className="dev-approval-host">{item.dev_host_name || "未保存测试"}</span>
                    <span className="admin-status">
                      {item.hop === "jump" ? "跳板机 · jump" : "目标机 · target"}
                    </span>
                    <span className={`admin-status ${meta.tone}`}>{meta.label}</span>
                  </div>
                  <div className="dev-approval-endpoint">
                    {endpointDiffers && (
                      <>
                        <code>{item.hostname}</code>
                        <span className="admin-muted">→</span>
                      </>
                    )}
                    <code>{item.pinned_ip}:{item.port}</code>
                  </div>
                  <div className="dev-approval-meta">
                    <span>申请于 <time>{formatDateTime(item.requested_at)}</time></span>
                    {item.decided_at && (
                      <span>
                        处理于 <time>{formatDateTime(item.decided_at)}</time>
                        {decider ? ` · ${decider}` : ""}
                      </span>
                    )}
                    {item.note && <span>备注：{item.note}</span>}
                  </div>
                </div>
                <div className="dev-approval-actions">
                  {item.status === "pending" && (
                    <>
                      <button
                        type="button"
                        className="button button-primary button-small"
                        disabled={!!busyId}
                        onClick={() => void decide(item, "approve")}
                      >
                        {isBusy && <LoaderCircle size={13} className="spin" />}批准
                      </button>
                      <button
                        type="button"
                        className="button button-ghost button-small"
                        disabled={!!busyId}
                        onClick={() => void decide(item, "reject")}
                      >
                        拒绝
                      </button>
                    </>
                  )}
                  {item.status === "approved" && (
                    <button
                      type="button"
                      className="button button-danger button-small"
                      disabled={!!busyId}
                      title="撤销后会立即断开该目标的活跃中继隧道"
                      onClick={() => void decide(item, "revoke")}
                    >
                      {isBusy && <LoaderCircle size={13} className="spin" />}撤销
                    </button>
                  )}
                  {(item.status === "rejected" || item.status === "revoked") && (
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={!!busyId}
                      onClick={() => void decide(item, "approve")}
                    >
                      {isBusy && <LoaderCircle size={13} className="spin" />}重新批准
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
