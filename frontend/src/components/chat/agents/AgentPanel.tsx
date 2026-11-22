import { Inbox, Square, Workflow } from "lucide-react";
import { isActive } from "../../../api";
import type { Approval, ChildAgent, Session } from "../../../types";
import { useSessionAgents } from "./useSessionAgents";

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
  const enabled = session?.orchestration === 1 && !session.archived_at;
  const { view, pending, stopAll, stop, deliver } = useSessionAgents(session?.id, enabled && connected, onNotice);
  if (!enabled || !view || (!view.agents.length && !view.pendingReports)) return null;
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
        <span className="agent-panel-title">子智能体 {view.agents.length}</span>
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
      {view.agents.map((agent) => {
        const approvalCount = waiting(agent.sessionId);
        const state = stateOf(agent, approvalCount);
        return (
          <div key={agent.sessionId} className="agent-card">
            <span className={`engine-logo engine-logo-${agent.engine}`} aria-hidden="true" />
            <button type="button" className="agent-card-name" onClick={() => open(agent.sessionId)} title="打开子对话">{agent.name}</button>
            <span className="agent-card-meta">{agent.model || "默认模型"} · {agent.access === "read" ? "只读" : "可写"}</span>
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
        );
      })}
    </div>
  );
}
