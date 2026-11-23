import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Eye, ListTodo, LoaderCircle, MinusCircle } from "lucide-react";
import type { ChildAgent, Session, WorkItemStatus, WorkItemView } from "../../../types";

const statusLabel: Record<WorkItemStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  verifying: "待验收",
  blocked: "受阻",
  completed: "已完成",
  cancelled: "已取消",
};

function StatusIcon({ status }: { status: WorkItemStatus }) {
  if (status === "completed") return <CheckCircle2 size={13} className="task-icon-done" aria-hidden="true" />;
  if (status === "in_progress") return <LoaderCircle size={13} className="spin task-icon-running" aria-hidden="true" />;
  if (status === "verifying") return <Eye size={13} className="task-icon-verifying" aria-hidden="true" />;
  if (status === "blocked") return <AlertTriangle size={13} className="task-icon-blocked" aria-hidden="true" />;
  if (status === "cancelled") return <MinusCircle size={13} className="task-icon-muted" aria-hidden="true" />;
  return <Circle size={13} className="task-icon-muted" aria-hidden="true" />;
}

/** Persistent task board card inside the master/Super Agent panel. */
export default function TaskBoardCard({
  tasks,
  agents,
  sessions,
  onOpen,
}: {
  tasks: WorkItemView[];
  agents: ChildAgent[];
  sessions: Session[];
  onOpen: (session: Session) => void;
}) {
  const allSettled = tasks.length > 0 && tasks.every((item) => item.status === "completed" || item.status === "cancelled");
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? !allSettled;
  if (!tasks.length) return null;
  const completed = tasks.filter((item) => item.status === "completed").length;
  const blocked = tasks.filter((item) => item.status === "blocked").length;
  const verifying = tasks.filter((item) => item.status === "verifying").length;
  const childByName = new Map(agents.map((agent) => [agent.name, agent]));
  const openAssignee = (name: string) => {
    const child = childByName.get(name);
    const target = child && sessions.find((item) => item.id === child.sessionId);
    if (target) onOpen(target);
  };
  return (
    <div className="agent-card task-board-card" aria-label="任务看板">
      <button type="button" className="task-board-header" aria-expanded={open} onClick={() => setManualOpen(!open)}>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <ListTodo size={13} aria-hidden="true" />
        <strong className="task-board-title">任务看板</strong>
        <span className="task-board-progress">{completed}/{tasks.length} 已完成</span>
        {verifying > 0 && <span className="agent-card-state agent-state-running">待验收 {verifying}</span>}
        {blocked > 0 && <span className="agent-card-state agent-state-error">受阻 {blocked}</span>}
      </button>
      {open && (
        <div className="task-board-list">
          {tasks.map((task) => {
            const detail = [task.description, task.acceptance ? `验收标准：${task.acceptance}` : null,
              task.dependsOn.length ? `依赖：${task.dependsOn.join("、")}` : null].filter(Boolean).join("\n");
            const hasSession = !!task.assignedAgent && !!childByName.get(task.assignedAgent)
              && sessions.some((item) => item.id === childByName.get(task.assignedAgent!)?.sessionId);
            return (
              <div key={task.id} className={`task-row task-status-${task.status}`} title={detail || task.title}>
                <StatusIcon status={task.status} />
                <code className="task-code">{task.code}</code>
                <span className="task-title">{task.title}</span>
                {task.dependsOn.length > 0 && task.status === "pending" && (
                  <small className="task-deps">等待 {task.dependsOn.join("+")}</small>
                )}
                {task.summary && <span className="task-summary" title={task.summary}>{task.summary}</span>}
                {task.assignedAgent && (
                  hasSession ? (
                    <button type="button" className="task-assignee" onClick={() => openAssignee(task.assignedAgent!)}
                      title={`打开子对话 ${task.assignedAgent}`}>@{task.assignedAgent}</button>
                  ) : (
                    <span className="task-assignee muted">@{task.assignedAgent}</span>
                  )
                )}
                <span className="task-state-label">{statusLabel[task.status]}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
