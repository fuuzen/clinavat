import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Eye, LoaderCircle, MinusCircle, Search, X } from "lucide-react";
import type { ChildAgent, Session, WorkItemStatus, WorkItemView } from "../../../types";

type TaskFilter = "all" | "open" | "completed";

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

/** Searchable, scrollable task board rendered inside the collapsible agent dock tray. */
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const childByName = useMemo(() => new Map(agents.map((agent) => [agent.name, agent])), [agents]);

  const completedCount = tasks.filter((item) => item.status === "completed").length;
  const openCount = tasks.filter((item) => item.status !== "completed" && item.status !== "cancelled").length;

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filter === "open" && (task.status === "completed" || task.status === "cancelled")) return false;
      if (filter === "completed" && task.status !== "completed") return false;
      if (!keyword) return true;
      return [task.code, task.title, task.summary, task.assignedAgent, task.description]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(keyword));
    });
  }, [tasks, filter, query]);

  const openAssignee = (name: string) => {
    const child = childByName.get(name);
    const target = child && sessions.find((item) => item.id === child.sessionId);
    if (target) onOpen(target);
  };

  return (
    <div className="agent-tray-section" aria-label="任务看板">
      <div className="agent-tray-toolbar">
        <div className="agent-tray-search">
          <Search size={12} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="检索任务编号、标题或指派…"
            aria-label="检索任务"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="icon-button" onClick={() => setQuery("")} aria-label="清除检索">
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="agent-tray-filters" role="group" aria-label="筛选任务状态">
          <button type="button" className={`agent-filter-chip${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
            全部 {tasks.length}
          </button>
          <button type="button" className={`agent-filter-chip${filter === "open" ? " active" : ""}`} onClick={() => setFilter("open")}>
            未完成 {openCount}
          </button>
          <button type="button" className={`agent-filter-chip${filter === "completed" ? " active" : ""}`} onClick={() => setFilter("completed")}>
            已完成 {completedCount}
          </button>
        </div>
      </div>

      <div className="agent-tray-scroll">
        {visible.length === 0 ? (
          <div className="agent-tray-empty">没有符合条件的任务</div>
        ) : (
          <div className="task-board-list">
            {visible.map((task) => {
              const detail = [
                task.description,
                task.acceptance ? `验收标准：${task.acceptance}` : null,
                task.dependsOn.length ? `依赖：${task.dependsOn.join("、")}` : null,
              ].filter(Boolean).join("\n");
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
    </div>
  );
}
