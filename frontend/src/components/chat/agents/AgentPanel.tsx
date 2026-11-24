import { useEffect, useState } from "react";
import { ChevronDown, Inbox, ListTodo, MessagesSquare, Search, Square, Workflow, X } from "lucide-react";
import { isActive } from "../../../api";
import type { Approval, Session } from "../../../types";
import { useSessionAgents } from "./useSessionAgents";
import AgentListPanel from "./AgentListPanel";
import DiscussionCard from "./DiscussionCard";
import TaskBoardCard from "./TaskBoardCard";

type DockTab = "tasks" | "agents" | "discussions";

interface Props {
  session?: Session;
  sessions: Session[];
  approvals: Approval[];
  connected: boolean;
  onOpen: (session: Session) => void;
  onNotice: (message: string) => void;
}

/** Compact collapsible dock above the composer for tasks, sub-agents and discussions. */
export default function AgentPanel({ session, sessions, approvals, connected, onOpen, onNotice }: Props) {
  const [activeTab, setActiveTab] = useState<DockTab | null>(null);
  const [discussionQuery, setDiscussionQuery] = useState("");
  const superMode = session?.orchestration_mode === "super";
  const enabled = !!session && !session.archived_at && (
    session.orchestration === 1
    || superMode
    || session.orchestration_mode === "hybrid"
    || sessions.some((item) => item.parent_session_id === session.id)
  );
  const { view, pending, stopAll, stop, deliver, merge, discard, handoff, archiveChild, stopDiscussion } = useSessionAgents(session?.id, enabled && connected, onNotice);

  useEffect(() => {
    setActiveTab(null);
    setDiscussionQuery("");
  }, [session?.id]);

  const tasks = view?.tasks ?? [];
  const discussions = view?.discussions ?? [];
  const agents = view?.agents ?? [];
  const activeAgents = agents.filter((agent) => !agent.archived);
  const archivedAgents = agents.filter((agent) => agent.archived);

  if (!enabled || !view || (!agents.length && !tasks.length && !discussions.length && !view.pendingReports)) return null;

  const waiting = (id: string) => approvals.filter((approval) => approval.session_id === id && ["pending", "PENDING"].includes(approval.status)).length;
  const totalApprovals = activeAgents.reduce((sum, agent) => sum + waiting(agent.sessionId), 0);
  const runningAgents = activeAgents.filter((agent) => agent.running || isActive(agent.status)).length;
  const pendingBranches = activeAgents.filter((agent) => agent.worktree && ["changes", "resolving"].includes(agent.worktree.state)).length;
  const conflictBranches = activeAgents.filter((agent) => agent.worktree?.state === "conflict").length;
  const busy = runningAgents > 0;

  const completedTasks = tasks.filter((item) => item.status === "completed").length;
  const verifyingTasks = tasks.filter((item) => item.status === "verifying").length;
  const blockedTasks = tasks.filter((item) => item.status === "blocked").length;
  const runningDiscussions = discussions.filter((item) => item.status === "running").length;

  const currentTab: DockTab | null =
    (activeTab === "tasks" && tasks.length > 0) ||
    (activeTab === "agents" && agents.length > 0) ||
    (activeTab === "discussions" && discussions.length > 0)
      ? activeTab : null;

  const toggle = (tab: DockTab) => setActiveTab((previous) => (previous === tab ? null : tab));
  const openChild = (id: string) => {
    const child = sessions.find((item) => item.id === id);
    if (child) onOpen(child);
  };

  const filteredDiscussions = discussionQuery.trim()
    ? discussions.filter((item) => {
        const keyword = discussionQuery.trim().toLowerCase();
        return item.topic.toLowerCase().includes(keyword)
          || item.participants.some((p) => p.name.toLowerCase().includes(keyword));
      })
    : discussions;

  return (
    <div className={`agent-panel agent-dock${currentTab ? " is-expanded" : ""}`} aria-label="编排协作面板">
      <div className="agent-dock-bar">
        <div className="agent-dock-tabs" role="tablist" aria-label="编排模块">
          {tasks.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={currentTab === "tasks"}
              className={`agent-dock-pill${currentTab === "tasks" ? " active" : ""}`}
              onClick={() => toggle("tasks")}
            >
              <ListTodo size={13} aria-hidden="true" />
              <span>任务 {completedTasks}/{tasks.length}</span>
              {verifyingTasks > 0 && <span className="agent-dock-badge badge-info">待验收 {verifyingTasks}</span>}
              {blockedTasks > 0 && <span className="agent-dock-badge badge-danger">受阻 {blockedTasks}</span>}
            </button>
          )}
          {agents.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={currentTab === "agents"}
              className={`agent-dock-pill${currentTab === "agents" ? " active" : ""}`}
              onClick={() => toggle("agents")}
            >
              <Workflow size={13} aria-hidden="true" />
              <span>{activeAgents.length > 0 ? `子智能体 ${activeAgents.length}` : `已归档 ${archivedAgents.length}`}</span>
              {runningAgents > 0 && <span className="agent-dock-badge badge-info">运行 {runningAgents}</span>}
              {totalApprovals > 0 && <span className="agent-dock-badge badge-warning">待审批 {totalApprovals}</span>}
              {conflictBranches > 0 && <span className="agent-dock-badge badge-danger">冲突 {conflictBranches}</span>}
              {conflictBranches === 0 && pendingBranches > 0 && <span className="agent-dock-badge badge-accent">待合并 {pendingBranches}</span>}
            </button>
          )}
          {discussions.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={currentTab === "discussions"}
              className={`agent-dock-pill${currentTab === "discussions" ? " active" : ""}`}
              onClick={() => toggle("discussions")}
            >
              <MessagesSquare size={13} aria-hidden="true" />
              <span>讨论 {discussions.length}</span>
              {runningDiscussions > 0 && <span className="agent-dock-badge badge-info">进行中</span>}
            </button>
          )}
        </div>
        <div className="agent-dock-actions">
          {view.pendingReports > 0 && (
            <button
              type="button"
              className="agent-panel-action"
              disabled={pending}
              onClick={() => void deliver()}
              title={view.reportsPaused ? "自动汇总已达上限，点击后把汇报交给主智能体" : "把尚未送达的汇报交给主智能体"}
            >
              <Inbox size={12} aria-hidden="true" />
              <span>{view.reportsPaused ? "投递" : "汇报"} {view.pendingReports}</span>
            </button>
          )}
          {busy && (
            <button
              type="button"
              className="agent-panel-action danger-text"
              disabled={pending}
              onClick={() => void stopAll()}
              title="停止主智能体和所有正在运行的子智能体"
            >
              <Square size={10} fill="currentColor" aria-hidden="true" />
              <span>全部停止</span>
            </button>
          )}
          {currentTab && (
            <button
              type="button"
              className="icon-button agent-dock-collapse"
              onClick={() => setActiveTab(null)}
              title="折叠面板"
              aria-label="折叠面板"
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {currentTab && (
        <div className="agent-dock-tray" role="tabpanel">
          {currentTab === "tasks" && (
            <TaskBoardCard tasks={tasks} agents={agents} sessions={sessions} onOpen={onOpen} />
          )}
          {currentTab === "agents" && (
            <AgentListPanel
              agents={agents}
              superMode={superMode}
              pending={pending}
              waitingCount={waiting}
              onOpen={openChild}
              onStop={(id) => void stop(id)}
              onArchive={(id) => void archiveChild(id)}
              onMerge={(id, onConflict) => void merge(id, onConflict)}
              onDiscard={(id) => void discard(id)}
              onHandoff={(id) => void handoff(id)}
            />
          )}
          {currentTab === "discussions" && (
            <div className="agent-tray-section">
              {discussions.length > 1 && (
                <div className="agent-tray-toolbar">
                  <div className="agent-tray-search">
                    <Search size={12} aria-hidden="true" />
                    <input
                      type="search"
                      value={discussionQuery}
                      placeholder="检索讨论主题或参与者…"
                      aria-label="检索讨论"
                      onChange={(event) => setDiscussionQuery(event.target.value)}
                    />
                    {discussionQuery && (
                      <button type="button" className="icon-button" onClick={() => setDiscussionQuery("")} aria-label="清除检索">
                        <X size={11} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="agent-tray-scroll">
                {filteredDiscussions.length === 0 ? (
                  <div className="agent-tray-empty">没有符合条件的讨论</div>
                ) : (
                  filteredDiscussions.map((discussion) => (
                    <DiscussionCard
                      key={discussion.id}
                      discussion={discussion}
                      sessions={sessions}
                      pending={pending}
                      onOpen={onOpen}
                      onStop={(id) => void stopDiscussion(id)}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
