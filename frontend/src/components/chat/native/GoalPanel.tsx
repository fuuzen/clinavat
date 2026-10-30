import { LoaderCircle, Pause, Pencil, Play, RefreshCw, Target, X } from "lucide-react";
import type { CodexGoal, CodexGoalControl } from "./useCodexGoal";
import "../../../styles/goal-panel.css";

const statusLabels: Record<CodexGoal["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "等待处理",
  usageLimited: "用量受限",
  budgetLimited: "预算已用尽",
  complete: "已完成",
};
const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.round(value)).toLocaleString("zh-CN") : "—";
function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const value = Math.max(0, Math.round(seconds));
  return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
}

export default function GoalPanel({ control }: { control: CodexGoalControl }) {
  if (!control.visible) return null;
  const { goal, pending, loading, editing, connected } = control;
  const disabled = pending || loading || !connected;
  return <section className="codex-goal" aria-label="Codex Goal">
    <header className="codex-goal-header">
      <div className="codex-goal-title"><Target size={16} /><strong>Goal</strong>
        {goal && <span className={`codex-goal-status goal-${goal.status}`}>{goal.status === "active" && !control.executing ? "等待继续" : statusLabels[goal.status]}</span>}
        {(loading || pending) && <LoaderCircle size={13} className="spin" aria-label={pending ? "正在保存 Goal" : "正在同步 Goal"} />}
      </div>
      <div className="codex-goal-actions">
        {goal && !editing && <>
          {goal.status === "active" && <button className="button button-small" type="button" disabled={disabled} onClick={() => void control.pause()} title="暂停 Goal 的自动继续"><Pause size={12} />暂停 Goal</button>}
          {goal.status !== "complete" && (goal.status !== "active" || !control.executing) && <button className="button button-small" type="button" disabled={disabled} onClick={() => void control.resume()} title="继续此 Goal"><Play size={12} />继续 Goal</button>}
          <button className="button button-small" type="button" disabled={disabled} onClick={() => void control.edit()}><Pencil size={12} />编辑</button>
        </>}
        <button className="icon-button" type="button" disabled={disabled} onClick={() => void control.refresh()} title="刷新 Goal" aria-label="刷新 Goal"><RefreshCw size={13} /></button>
        {!goal && !editing && <button className="icon-button" type="button" disabled={pending} onClick={control.dismiss} title="关闭 Goal 面板" aria-label="关闭 Goal 面板"><X size={14} /></button>}
      </div>
    </header>
    {goal && !editing && <p className="codex-goal-objective">{goal.objective}</p>}
    {goal && <div className="codex-goal-usage">
      <span>已用 {count(goal.tokensUsed)} token{goal.tokenBudget !== null ? ` / ${count(goal.tokenBudget)}` : ""}</span>
      <span>累计 {duration(goal.timeUsedSeconds)}</span>
    </div>}
    {!goal && !editing && !loading && <div className="codex-goal-empty"><span>尚未设置目标。使用 /goal 目标内容，或在这里创建。</span><button className="button button-small" type="button" disabled={disabled} onClick={control.beginCreate}>设置目标</button></div>}
    {editing && <form className="codex-goal-editor" onSubmit={event => { event.preventDefault(); void control.save(); }}>
      <label htmlFor="codex-goal-objective">{goal ? "编辑目标" : "设定目标"}</label>
      <textarea id="codex-goal-objective" value={control.draft ?? ""} onChange={event => control.setDraft(event.target.value)} rows={3} maxLength={4000} disabled={pending} placeholder="描述完成条件，以及需要遵守的约束…" autoFocus />
      {goal?.status === "paused" && <small>保存后仍保持暂停，累计用量保留。</small>}
      <div className="codex-goal-editor-actions"><button className="button button-small" type="button" disabled={pending} onClick={control.cancelEdit}>取消</button><button className="button button-primary button-small" type="submit" disabled={disabled || !control.draft?.trim()}>{pending ? "保存中…" : "保存目标"}</button></div>
    </form>}
    {!connected && <p className="codex-goal-note" role="status">连接已断开。当前显示上次状态，恢复连接后将自动同步。</p>}
    {goal?.status === "active" && !control.executing && <p className="codex-goal-note">目标已保留，点击“继续 Goal”恢复执行。</p>}
    {goal?.status === "blocked" && <p className="codex-goal-note">处理当前阻塞后，使用“继续 Goal”恢复。</p>}
    {goal?.status === "usageLimited" && <p className="codex-goal-note">恢复可用额度后，可尝试继续 Goal。</p>}
    {goal?.status === "budgetLimited" && <p className="codex-goal-note">此目标已达到设置的预算限制。</p>}
    {control.error && <p className="codex-goal-error" role="alert">{control.error}</p>}
  </section>;
}
