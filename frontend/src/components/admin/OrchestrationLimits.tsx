import { useEffect, useState } from "react";
import { Check, LoaderCircle, RotateCcw, Save, Workflow } from "lucide-react";
import { api, errorText } from "../../api";
import type { OrchestrationSettings } from "../../types";
import "../../styles/admin-site.css";

interface Response { settings: OrchestrationSettings; defaults: OrchestrationSettings }

const fields: { key: keyof OrchestrationSettings; label: string; min: number; max: number; help: string }[] = [
  { key: "runningPerMaster", label: "每个主对话同时运行的子智能体", min: 1, max: 16, help: "正在执行主智能体任务的子智能体。" },
  { key: "runningPerUser", label: "每个用户同时运行的子智能体", min: 1, max: 64, help: "该用户所有主对话合计。" },
  { key: "sharedWritersPerMaster", label: "共用项目目录的可写子智能体", min: 0, max: 8, help: "它们的工作目录还必须互不包含；0 表示只允许使用 worktree 的可写子智能体。" },
  { key: "worktreeWritersPerMaster", label: "使用 worktree 的可写子智能体", min: 0, max: 8, help: "每个都有自己的分支、镜像和同步会话，占用工作区磁盘。" },
  { key: "reportTurnsPerMessage", label: "每条用户消息后的自动汇总轮数", min: 1, max: 100, help: "超过后汇报留在子智能体面板中，由用户手动投递。" },
];

/** Limits on master agents and their children, for every user; changes apply to the next tool call. */
export default function OrchestrationLimits() {
  const [saved, setSaved] = useState<Response | null>(null);
  const [draft, setDraft] = useState<OrchestrationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<Response>("/admin/settings/orchestration", { signal: controller.signal })
      .then((value) => { setSaved(value); setDraft(value.settings); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, []);
  const dirty = !!saved && !!draft && fields.some(({ key }) => saved.settings[key] !== draft[key]);
  const valid = !!draft && fields.every(({ key, min, max }) => Number.isInteger(draft[key]) && draft[key] >= min && draft[key] <= max);
  return (
    <section className="admin-card admin-site-section" aria-busy={!saved || saving}>
      <div className="admin-card-heading"><div><Workflow size={17} /><h3>主智能体与子智能体</h3></div></div>
      <p className="admin-site-description">
        开启编排的对话可以派生子智能体。以下限额对所有用户生效，修改后从下一次派生或投递起生效，不影响正在运行的子智能体。
      </p>
      {!saved && !error && <div className="loading-state">正在读取…</div>}
      {saved && draft && (
        <form className="orchestration-limits" onSubmit={(event) => {
          event.preventDefault();
          setSaving(true); setError(""); setMessage("");
          api<Response>("/admin/settings/orchestration", { method: "PUT", body: JSON.stringify(draft) })
            .then((value) => { setSaved(value); setDraft(value.settings); setMessage("已保存。"); })
            .catch((cause) => setError(errorText(cause)))
            .finally(() => setSaving(false));
        }}>
          {fields.map(({ key, label, min, max, help }) => (
            <label key={key}>
              <span>{label}</span>
              <input type="number" min={min} max={max} step={1} required value={Number.isNaN(draft[key]) ? "" : draft[key]} disabled={saving}
                onChange={(event) => { setDraft({ ...draft, [key]: event.target.valueAsNumber }); setMessage(""); }} />
              <small>{help}默认 {saved.defaults[key]}。</small>
            </label>
          ))}
          <div className="question-policy-settings-actions">
            <button type="button" className="button button-secondary button-small" disabled={saving}
              onClick={() => { setDraft(saved.defaults); setMessage(""); }}>
              <RotateCcw size={14} />恢复默认值
            </button>
            <button type="submit" className="button button-primary button-small" disabled={saving || !dirty || !valid}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存
            </button>
          </div>
        </form>
      )}
      {error && <p className="admin-site-access-error" role="alert">{error}</p>}
      {message && <p className="admin-site-access-status" role="status"><Check size={13} />{message}</p>}
    </section>
  );
}
