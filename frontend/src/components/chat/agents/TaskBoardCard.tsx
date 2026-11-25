import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Circle,
  Eye,
  LoaderCircle,
  MinusCircle,
  Search,
  X,
} from "lucide-react";
import {
  archiveSessionTasks,
  errorText,
  fetchSessionTasks,
  isMaintenanceMode,
  onMaintenanceChange,
} from "../../../api";
import type { ChildAgent, Session, WorkItemStatus, WorkItemView } from "../../../types";
import "./TaskBoardCard.css";

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

function TaskRow({
  task,
  archived,
  childByName,
  sessions,
  onOpenAssignee,
}: {
  task: WorkItemView;
  archived?: boolean;
  childByName: Map<string, ChildAgent>;
  sessions: Session[];
  onOpenAssignee: (name: string) => void;
}) {
  const detail = [
    task.description,
    task.acceptance ? `验收标准：${task.acceptance}` : null,
    task.dependsOn.length ? `依赖：${task.dependsOn.join("、")}` : null,
  ].filter(Boolean).join("\n");
  const hasSession = !!task.assignedAgent && !!childByName.get(task.assignedAgent)
    && sessions.some((item) => item.id === childByName.get(task.assignedAgent!)?.sessionId);
  const codeText = archived ? `S${task.stage ?? 1}·${task.code}` : task.code;

  return (
    <div
      className={`task-row task-status-${task.status}${archived ? " task-row-archived" : ""}`}
      title={detail || task.title}
    >
      <StatusIcon status={task.status} />
      <code className={`task-code${archived ? " task-code-staged" : ""}`}>{codeText}</code>
      <span className="task-title">{task.title}</span>
      {!archived && task.dependsOn.length > 0 && task.status === "pending" && (
        <small className="task-deps">等待 {task.dependsOn.join("+")}</small>
      )}
      {task.summary && <span className="task-summary" title={task.summary}>{task.summary}</span>}
      {task.assignedAgent && (
        hasSession ? (
          <button
            type="button"
            className="task-assignee"
            onClick={() => onOpenAssignee(task.assignedAgent!)}
            title={`打开子对话 ${task.assignedAgent}`}
          >
            @{task.assignedAgent}
          </button>
        ) : (
          <span className="task-assignee muted">@{task.assignedAgent}</span>
        )
      )}
      <span className="task-state-label">{statusLabel[task.status]}</span>
    </div>
  );
}

/** Searchable, scrollable task board rendered inside the collapsible agent dock tray. */
export default function TaskBoardCard({
  sessionId,
  tasks,
  archivedCount = 0,
  agents,
  sessions,
  readOnly,
  onOpen,
  onNotice,
}: {
  sessionId?: string;
  tasks: WorkItemView[];
  archivedCount?: number;
  agents: ChildAgent[];
  sessions: Session[];
  readOnly?: boolean;
  onOpen: (session: Session) => void;
  onNotice?: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [maintenance, setMaintenance] = useState<boolean>(() => isMaintenanceMode());
  const [archiving, setArchiving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [archivedTasks, setArchivedTasks] = useState<WorkItemView[] | null>(null);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  useEffect(() => onMaintenanceChange(setMaintenance), []);

  useEffect(() => {
    setShowArchived(false);
    setArchivedTasks(null);
    setArchivedError(null);
  }, [sessionId]);

  const isReadOnly = Boolean(readOnly) || maintenance;
  const childByName = useMemo(() => new Map(agents.map((agent) => [agent.name, agent])), [agents]);

  const completedCount = tasks.filter((item) => item.status === "completed").length;
  const archivableCount = tasks.filter((item) => item.status === "completed" || item.status === "cancelled").length;
  const openCount = tasks.filter((item) => item.status !== "completed" && item.status !== "cancelled").length;

  const loadArchived = useCallback(async () => {
    if (!sessionId) return;
    setLoadingArchived(true);
    setArchivedError(null);
    try {
      const res = await fetchSessionTasks(sessionId, true);
      setArchivedTasks(res.archivedTasks ?? []);
    } catch (cause) {
      setArchivedError(errorText(cause));
    } finally {
      setLoadingArchived(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!showArchived) return;
    if (archivedCount === 0) {
      setArchivedTasks([]);
      return;
    }
    void loadArchived();
  }, [showArchived, archivedCount, loadArchived]);

  const handleArchiveCompleted = async () => {
    if (!sessionId || archiving || isReadOnly || archivableCount === 0) return;
    setArchiving(true);
    try {
      await archiveSessionTasks(sessionId);
      if (showArchived) await loadArchived();
    } catch (cause) {
      onNotice?.(errorText(cause));
    } finally {
      setArchiving(false);
    }
  };

  const keyword = query.trim().toLowerCase();

  const matchesKeyword = useCallback((task: WorkItemView) => {
    if (!keyword) return true;
    const stagedCode = `s${task.stage ?? 1}·${task.code}`;
    return [task.code, stagedCode, task.title, task.summary, task.assignedAgent, task.description]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword));
  }, [keyword]);

  const visible = useMemo(() => tasks.filter((task) => {
    if (filter === "open" && (task.status === "completed" || task.status === "cancelled")) return false;
    if (filter === "completed" && task.status !== "completed") return false;
    return matchesKeyword(task);
  }), [tasks, filter, matchesKeyword]);

  const visibleArchived = useMemo(
    () => (archivedTasks ?? []).filter(matchesKeyword),
    [archivedTasks, matchesKeyword],
  );

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
          {sessionId && archivableCount > 0 && !isReadOnly && (
            <button
              type="button"
              className="task-archive-btn"
              disabled={archiving}
              onClick={() => void handleArchiveCompleted()}
              title="归档当前阶段全部已完成或已取消的任务"
            >
              {archiving ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : <Archive size={11} aria-hidden="true" />}
              <span>归档已完成</span>
            </button>
          )}
        </div>
      </div>

      <div className="agent-tray-scroll">
        {visible.length === 0 ? (
          <div className="agent-tray-empty">
            {tasks.length === 0 && archivedCount > 0
              ? "当前阶段暂无活跃任务，新任务将从 T1 开始编号"
              : "没有符合条件的任务"}
          </div>
        ) : (
          <div className="task-board-list">
            {visible.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                childByName={childByName}
                sessions={sessions}
                onOpenAssignee={openAssignee}
              />
            ))}
          </div>
        )}

        {archivedCount > 0 && (
          <div className="task-archived-section">
            <button
              type="button"
              className={`task-archived-toggle${showArchived ? " expanded" : ""}`}
              aria-expanded={showArchived}
              onClick={() => setShowArchived((previous) => !previous)}
            >
              <ChevronRight size={12} className="task-archived-chevron" aria-hidden="true" />
              <Archive size={11} aria-hidden="true" />
              <span>已归档 ({archivedCount})</span>
            </button>

            {showArchived && (
              loadingArchived ? (
                <div className="task-archived-hint">
                  <LoaderCircle size={12} className="spin" aria-hidden="true" />
                  <span>正在加载已归档任务…</span>
                </div>
              ) : archivedError ? (
                <div className="task-archived-hint">
                  <span>加载失败：{archivedError}</span>
                  <button type="button" className="task-archived-retry" onClick={() => void loadArchived()}>
                    重试
                  </button>
                </div>
              ) : visibleArchived.length === 0 ? (
                <div className="task-archived-hint">
                  {keyword ? "没有匹配的已归档任务" : "暂无已归档任务"}
                </div>
              ) : (
                <div className="task-board-list">
                  {visibleArchived.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      archived
                      childByName={childByName}
                      sessions={sessions}
                      onOpenAssignee={openAssignee}
                    />
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
