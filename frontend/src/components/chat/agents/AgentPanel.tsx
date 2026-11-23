import { GitBranch, Inbox, Square, Workflow } from "lucide-react";
import { isActive } from "../../../api";
import type { Approval, ChildAgent, Session } from "../../../types";
import { useSessionAgents } from "./useSessionAgents";
import DiscussionCard from "./DiscussionCard";

interface Props {
  session?: Session;
  sessions: Session[];
  approvals: Approval[];
  connected: boolean;
  onOpen: (session: Session) => void;
  onNotice: (message: string) => void;
}

function stateOf(agent: ChildAgent, approvals: number): { label: string; tone: string } {
  if (approvals) return { label: "等待审批", tone: "waiting" };
  if (agent.running || isActive(agent.status)) return { label: "运行中", tone: "running" };
  if (agent.lastTask?.status === "error") return { label: "出错", tone: "error" };
  if (agent.lastTask?.status === "interrupted") return { label: "已停止", tone: "idle" };
  if (agent.lastTask?.status === "completed") return { label: "已完成", tone: "done" };
  return { label: "空闲", tone: "idle" };
}

/** A master conversation's child agents above its composer: their state, their approvals and their reports. */
export default function AgentPanel({ session, sessions, approvals, connected, onOpen, onNotice }: Props) {
  // A master, or a conversation that hosts a discussion the user started.
  const enabled = !!session && !session.archived_at && (session.orchestration === 1 || sessions.some((item) => item.parent_session_id === session.id));
  const { view, pending, stopAll, stop, deliver, merge, discard, handoff, stopDiscussion } = useSessionAgents(session?.id, enabled && connected, onNotice);
  // Running discussions, or else the latest one.
  const discussions = view?.discussions.some((item) => item.status === "running")
    ? view.discussions.filter((item) => item.status === "running") : view?.discussions.slice(0, 1) ?? [];
  if (!enabled || !view || (!view.agents.length && !view.pendingReports && !discussions.length)) return null;
  const waiting = (id: string) => approvals.filter((approval) => approval.session_id === id && ["pending", "PENDING"].includes(approval.status)).length;
  const busy = view.agents.some((agent) => agent.running || isActive(agent.status));
  const open = (id: string) => {
    const child = sessions.find((item) => item.id === id);
    if (child) onOpen(child);
  };
  return (
    <div className="agent-panel" aria-label="子智能体">
      <div className="agent-panel-header">
        <Workflow size={13} aria-hidden="true" />
        <span className="agent-panel-title">{view.agents.length ? `子智能体 ${view.agents.length}` : "讨论"}</span>
        {view.pendingReports > 0 && (
          <button type="button" className="agent-panel-action" disabled={pending} onClick={() => void deliver()}
            title={view.reportsPaused ? "自动汇总已达上限，点击后把汇报交给主智能体" : "把尚未送达的汇报交给主智能体"}>
            <Inbox size={12} aria-hidden="true" />
            {view.reportsPaused ? "已暂停自动汇总 · " : ""}投递 {view.pendingReports} 条汇报
          </button>
        )}
        {busy && (
          <button type="button" className="agent-panel-action danger-text" disabled={pending} onClick={() => void stopAll()} title="停止主智能体和所有正在运行的子智能体">
            <Square size={10} fill="currentColor" aria-hidden="true" />
            全部停止
          </button>
        )}
      </div>
      {discussions.map((discussion) => (
        <DiscussionCard key={discussion.id} discussion={discussion} sessions={sessions} pending={pending} onOpen={onOpen}
          onStop={(id) => void stopDiscussion(id)} />
      ))}
      {view.agents.map((agent) => {
        const approvalCount = waiting(agent.sessionId);
        const state = stateOf(agent, approvalCount);
        const meta = [agent.model || "默认模型", agent.access === "read" ? "只读" : agent.isolation === "worktree" ? "独立 worktree" : "可写",
          agent.directory].filter(Boolean).join(" · ");
        const branch = agent.worktree && ["changes", "conflict", "resolving"].includes(agent.worktree.state) ? agent.worktree : null;
        return (
          <div key={agent.sessionId} className="agent-card">
            <div className="agent-card-row">
              <span className={`engine-logo engine-logo-${agent.engine}`} aria-hidden="true" />
              <button type="button" className="agent-card-name" onClick={() => open(agent.sessionId)} title="打开子对话">{agent.name}</button>
              <span className="agent-card-meta" title={meta}>{meta}</span>
              <span className={`agent-card-state agent-state-${state.tone}`}>{state.label}</span>
              {approvalCount > 0 && (
                <button type="button" className="agent-card-approve" onClick={() => open(agent.sessionId)}>去审批 {approvalCount}</button>
              )}
              {(agent.running || isActive(agent.status)) && (
                <button type="button" className="agent-card-stop" disabled={pending} onClick={() => void stop(agent.sessionId)}
                  title={`停止 ${agent.name}`} aria-label={`停止子智能体 ${agent.name}`}>
                  <Square size={10} fill="currentColor" aria-hidden="true" />
                </button>
              )}
            </div>
            {branch && !agent.running && (
              <div className="agent-card-branch">
                <GitBranch size={12} aria-hidden="true" />
                <span className="agent-card-branch-name" title={branch.branch ?? ""}>
                  {branch.state === "changes" ? "待合并" : branch.state === "conflict" ? `合并冲突：${branch.conflicts.join("、")}` : "冲突已留在主目录，解决并提交后清理"}
                </span>
                {branch.state === "changes" && <>
                  <button type="button" disabled={pending} onClick={() => void merge(agent.sessionId, "abort")}>合并</button>
                  <button type="button" className="danger-text" disabled={pending} onClick={() => void discard(agent.sessionId)}>丢弃</button>
                </>}
                {branch.state === "conflict" && <>
                  <button type="button" disabled={pending} onClick={() => void merge(agent.sessionId, "leave")}
                    title="在主目录中重新合并并保留冲突标记，由你解决后提交">我来处理</button>
                  <button type="button" disabled={pending} onClick={() => void handoff(agent.sessionId)} title="把冲突交给主智能体处理">交给主智能体</button>
                  <button type="button" className="danger-text" disabled={pending} onClick={() => void discard(agent.sessionId)}>丢弃</button>
                </>}
                {branch.state === "resolving" && (
                  <button type="button" disabled={pending} onClick={() => void discard(agent.sessionId)} title="删除子智能体的 worktree 和分支">清理分支</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
