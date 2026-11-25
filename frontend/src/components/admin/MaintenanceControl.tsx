import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, Power, RefreshCw, Save, Sparkles, Wrench } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { MaintenanceActivity, MaintenanceState } from "../../types";
import "../../styles/maintenance.css";

interface StatusResponse {
  maintenance: MaintenanceState;
  activity: MaintenanceActivity;
}

interface MutationResponse extends StatusResponse {
  reclaimedIdle: number;
}

const POLL_INTERVAL_MS = 4000;
const POST_ACTION_REFRESH_MS = 1500;

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export default function MaintenanceControl() {
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null);
  const [activity, setActivity] = useState<MaintenanceActivity | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const followUpTimerRef = useRef<number | undefined>(undefined);

  const applyStatus = useCallback((data: StatusResponse, syncDraft = false) => {
    setMaintenance(data.maintenance);
    setActivity(data.activity);
    if (syncDraft || !draftDirtyRef.current) {
      setMessageDraft(data.maintenance.message ?? "");
      draftDirtyRef.current = false;
    }
  }, []);

  const load = useCallback(async (silent = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const data = await api<StatusResponse>("/admin/maintenance");
      if (!mountedRef.current) return;
      applyStatus(data);
      setError("");
    } catch (cause) {
      if (mountedRef.current && !silent) setError(errorText(cause));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && !silent) setLoading(false);
    }
  }, [applyStatus]);

  const scheduleFollowUp = useCallback(() => {
    window.clearTimeout(followUpTimerRef.current);
    followUpTimerRef.current = window.setTimeout(() => void load(true), POST_ACTION_REFRESH_MS);
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, POLL_INTERVAL_MS);
    const onChanged = () => void load(true);
    window.addEventListener("clinavat:maintenance", onChanged);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.clearTimeout(followUpTimerRef.current);
      window.removeEventListener("clinavat:maintenance", onChanged);
    };
  }, [load]);

  async function submitMaintenance(nextEnabled: boolean, onlyUpdateMessage = false) {
    setToggling(true);
    setError("");
    setFeedback("");
    try {
      const body = nextEnabled ? { enabled: true, message: messageDraft.trim() || null } : { enabled: false };
      const res = await post<MutationResponse>("/admin/maintenance", body);
      if (!mountedRef.current) return;
      applyStatus(res, true);
      setFeedback(
        onlyUpdateMessage
          ? "已更新维护提示语并实时同步至所有在线用户。"
          : nextEnabled
            ? res.reclaimedIdle > 0
              ? `已进入维护模式，并回收 ${res.reclaimedIdle} 个空闲常驻进程。`
              : "已进入维护模式，所有在线用户已切换为只读态。"
            : "已退出维护模式，服务已恢复正常访问。",
      );
      scheduleFollowUp();
    } catch (cause) {
      if (mountedRef.current) setError(errorText(cause));
    } finally {
      if (mountedRef.current) setToggling(false);
    }
  }

  async function handleReclaimIdle() {
    setReclaiming(true);
    setError("");
    setFeedback("");
    try {
      const res = await post<MutationResponse>("/admin/maintenance/reclaim-idle", {});
      if (!mountedRef.current) return;
      applyStatus(res);
      setFeedback(
        res.reclaimedIdle > 0
          ? `已回收 ${res.reclaimedIdle} 个空闲常驻 CLI 进程。`
          : "当前没有可回收的空闲常驻 CLI 进程。",
      );
      scheduleFollowUp();
    } catch (cause) {
      if (mountedRef.current) setError(errorText(cause));
    } finally {
      if (mountedRef.current) setReclaiming(false);
    }
  }

  const enabled = !!maintenance?.enabled;
  const ready = !!activity?.readyToPublish;
  const busy = toggling || reclaiming;
  const messageChanged = enabled && messageDraft.trim() !== (maintenance?.message ?? "");
  const metrics = [
    { label: "活跃对话", value: activity?.activeSessions, blocking: true, hint: "运行中或待审批会话" },
    { label: "运行中轮次", value: activity?.activeTurns, blocking: true, hint: "正在执行或暂停的轮次" },
    { label: "待处理审批", value: activity?.pendingApprovals, blocking: true, hint: "等待用户确认的工具审批" },
    { label: "空闲常驻 CLI", value: activity?.idleResidentSessions, blocking: true, hint: "可立即回收的常驻进程" },
    { label: "活跃槽位", value: activity?.activeSlots, blocking: true, hint: "当前占用中的账号槽位" },
    { label: "停放槽位", value: activity?.parkedSlots, blocking: false, hint: "已停放，不阻塞发布" },
  ];

  return (
    <section className="admin-card maintenance-control" aria-labelledby="admin-host-maintenance-heading" aria-busy={busy}>
      <div className="maintenance-control-head">
        <div className="maintenance-control-title">
          <span className="admin-host-icon"><Wrench size={19} /></span>
          <div>
            <h3 id="admin-host-maintenance-heading">维护操作与发布控制</h3>
            <p>开启维护模式后，在线用户会实时进入只读态，可继续浏览历史对话并收尾运行中任务；面板每 4 秒自动刷新活跃度。</p>
          </div>
        </div>
        <div className="maintenance-control-head-actions">
          <span className={`admin-status ${enabled ? "warning" : "success"}`}>
            <span className="admin-host-status-dot" aria-hidden="true" />
            {maintenance ? (enabled ? "维护中" : "正常运行") : "读取中"}
          </span>
          <button type="button" className="button button-secondary button-small" onClick={() => void load(false)} disabled={loading || busy}>
            <RefreshCw size={13} className={loading ? "spin" : ""} />刷新
          </button>
        </div>
      </div>

      {activity && (
        <div className={`maintenance-readiness ${ready ? "ready" : "busy"}`} role="status">
          <span className="maintenance-readiness-badge">
            {ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {ready ? "可立即发布更新" : "暂不建议发布（存在活跃任务或未回收槽位）"}
          </span>
          <span className="maintenance-readiness-note">
            {ready
              ? "活跃对话、运行轮次、审批、空闲常驻 CLI 与活跃槽位均已清零。"
              : "建议先开启维护模式或点击下方「立即回收空闲槽位」，等待活跃任务收尾。"}
          </span>
        </div>
      )}

      <div className="maintenance-metrics" aria-label="系统实时活跃度">
        {metrics.map((item) => (
          <div className={`maintenance-metric${item.blocking && (item.value ?? 0) > 0 ? " blocking" : ""}`} key={item.label}>
            <span className="maintenance-metric-label">{item.label}</span>
            <strong className="maintenance-metric-value">{item.value ?? "—"}</strong>
            <span className="maintenance-metric-hint">{item.hint}</span>
          </div>
        ))}
      </div>

      {enabled && maintenance && (
        <div className="maintenance-meta">
          <span>开启人：{maintenance.enabledByUsername || "管理员"}</span>
          <span>开启时间：{formatTimestamp(maintenance.enabledAt)}</span>
          {maintenance.updatedAt && <span>最近更新：{formatTimestamp(maintenance.updatedAt)}</span>}
        </div>
      )}

      {feedback && <div className="success-note" role="status"><CheckCircle2 size={15} /><span>{feedback}</span></div>}
      {error && <div className="inline-error" role="alert">{error}</div>}

      <div className="maintenance-form">
        <label htmlFor="maintenance-message-input">
          自定义维护提示语（可选）
          <input
            id="maintenance-message-input"
            type="text"
            maxLength={500}
            value={messageDraft}
            disabled={busy}
            onChange={(event) => { draftDirtyRef.current = true; setMessageDraft(event.target.value); }}
            placeholder="留空则使用默认只读维护提示语"
          />
        </label>
        <div className="maintenance-actions">
          <button
            type="button"
            className={`button button-small ${enabled ? "button-primary" : "button-danger"}`}
            disabled={busy || !maintenance}
            onClick={() => void submitMaintenance(!enabled)}
          >
            {toggling ? <LoaderCircle size={14} className="spin" /> : <Power size={14} />}
            {enabled ? "退出维护模式" : "开启维护模式"}
          </button>
          {messageChanged && (
            <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void submitMaintenance(true, true)}>
              <Save size={14} />更新提示语
            </button>
          )}
          <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void handleReclaimIdle()}>
            {reclaiming ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
            立即回收空闲槽位
          </button>
        </div>
      </div>
    </section>
  );
}
