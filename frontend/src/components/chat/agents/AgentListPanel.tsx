import { useMemo, useState } from "react";
import { Archive, GitBranch, Search, Square, X } from "lucide-react";
import { isActive } from "../../../api";
import type { ChildAgent } from "../../../types";

type AgentFilter = "all" | "active" | "attention";

interface Props {
  agents: ChildAgent[];
  superMode: boolean;
  pending: boolean;
  waitingCount: (sessionId: string) => number;
  onOpen: (sessionId: string) => void;
  onStop: (childId: string) => void;
  onArchive: (childId: string) => void;
  onMerge: (childId: string, onConflict: "abort" | "leave") => void;
  onDiscard: (childId: string) => void;
  onHandoff: (childId: string) => void;
}

function stateOf(agent: ChildAgent, approvals: number): { label: string; tone: string } {
  if (approvals) return { label: "等待审批", tone: "waiting" };
  if (agent.running || isActive(agent.status)) return { label: "运行中", tone: "running" };
  if (agent.lastTask?.status === "error") return { label: "出错", tone: "error" };
  if (agent.lastTask?.status === "interrupted") return { label: "已停止", tone: "idle" };
  if (agent.lastTask?.status === "completed") return { label: "已完成", tone: "done" };
  return { label: "空闲", tone: "idle" };
}

function needsAttention(agent: ChildAgent, approvals: number): boolean {
  if (approvals > 0 || agent.pendingReports > 0 || agent.lastTask?.status === "error") return true;
  return Boolean(agent.worktree && ["changes", "conflict", "resolving"].includes(agent.worktree.state));
}

export default function AgentListPanel(props: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [showArchived, setShowArchived] = useState(false);

  const activeAgents = useMemo(() => props.agents.filter((agent) => !agent.archived), [props.agents]);
  const archivedAgents = useMemo(() => props.agents.filter((agent) => agent.archived), [props.agents]);
  const onlyArchived = activeAgents.length === 0 && archivedAgents.length > 0;
  const includeArchived = showArchived || onlyArchived;

  const runningCount = activeAgents.filter((agent) => agent.running || isActive(agent.status)).length;
  const attentionCount = activeAgents.filter((agent) => needsAttention(agent, props.waitingCount(agent.sessionId))).length;

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const base = includeArchived ? props.agents : activeAgents;
    return base.filter((agent) => {
      if (filter === "active" && !(agent.running || isActive(agent.status))) return false;
      if (filter === "attention" && !needsAttention(agent, props.waitingCount(agent.sessionId))) return false;
      if (!keyword) return true;
      return [agent.name, agent.model, agent.engine, agent.directory, agent.worktree?.branch]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(keyword));
    });
  }, [props.agents, activeAgents, includeArchived, filter, query, props.waitingCount]);

  return (
    <div className="agent-tray-section">
      <div className="agent-tray-toolbar">
        <div className="agent-tray-search">
          <Search size={12} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="检索子智能体名称、模型或目录…"
            aria-label="检索子智能体"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="icon-button" onClick={() => setQuery("")} aria-label="清除检索">
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="agent-tray-filters" role="group" aria-label="筛选子智能体">
          <button type="button" className={`agent-filter-chip${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
            全部 {includeArchived ? props.agents.length : activeAgents.length}
          </button>
          {runningCount > 0 && (
            <button type="button" className={`agent-filter-chip${filter === "active" ? " active" : ""}`} onClick={() => setFilter("active")}>
              运行中 {runningCount}
            </button>
          )}
          {attentionCount > 0 && (
            <button type="button" className={`agent-filter-chip${filter === "attention" ? " active" : ""}`} onClick={() => setFilter("attention")}>
              待处理 {attentionCount}
            </button>
          )}
          {archivedAgents.length > 0 && !onlyArchived && (
            <button
              type="button"
              className={`agent-filter-chip${showArchived ? " active" : ""}`}
              aria-pressed={showArchived}
              onClick={() => setShowArchived(!showArchived)}
              title={showArchived ? "隐藏已归档的子智能体" : "显示已归档的子智能体"}
            >
              <Archive size={11} aria-hidden="true" />
              已归档 {archivedAgents.length}
            </button>
          )}
        </div>
      </div>

      <div className="agent-tray-scroll">
        {visible.length === 0 ? (
          <div className="agent-tray-empty">没有符合条件的子智能体</div>
        ) : (
          visible.map((agent) => {
            const approvalCount = props.waitingCount(agent.sessionId);
            const state = agent.archived ? { label: "已归档", tone: "idle" } : stateOf(agent, approvalCount);
            const meta = [
              agent.model || "默认模型",
              agent.access === "read" ? "只读" : agent.isolation === "worktree" ? "独立 worktree" : "可写",
              agent.ephemeral ? "自动回收" : null,
              agent.directory,
            ].filter(Boolean).join(" · ");
            const branch = agent.worktree && ["changes", "conflict", "resolving"].includes(agent.worktree.state) ? agent.worktree : null;
            const canArchive = !agent.archived && !agent.running && !isActive(agent.status) && !branch && !agent.pendingReports;
            return (
              <div key={agent.sessionId} className={`agent-card${agent.archived ? " agent-card-archived" : ""}`}>
                <div className="agent-card-row">
                  <span className={`engine-logo engine-logo-${agent.engine}`} aria-hidden="true" />
                  <button type="button" className="agent-card-name" onClick={() => props.onOpen(agent.sessionId)} title="打开子对话">
                    {agent.name}
                  </button>
                  <span className="agent-card-meta" title={meta}>{meta}</span>
                  <span className={`agent-card-state agent-state-${state.tone}`}>{state.label}</span>
                  {approvalCount > 0 && (
                    <button type="button" className="agent-card-approve" onClick={() => props.onOpen(agent.sessionId)}>
                      去审批 {approvalCount}
                    </button>
                  )}
                  {canArchive && (
                    <button type="button" className="agent-card-stop" disabled={props.pending} onClick={() => props.onArchive(agent.sessionId)}
                      title={`归档 ${agent.name}`} aria-label={`归档子智能体 ${agent.name}`}>
                      <Archive size={12} aria-hidden="true" />
                    </button>
                  )}
                  {(agent.running || isActive(agent.status)) && (
                    <button type="button" className="agent-card-stop" disabled={props.pending} onClick={() => props.onStop(agent.sessionId)}
                      title={`停止 ${agent.name}`} aria-label={`停止子智能体 ${agent.name}`}>
                      <Square size={10} fill="currentColor" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {branch && !agent.running && (
                  <div className="agent-card-branch">
                    <GitBranch size={12} aria-hidden="true" />
                    <span className="agent-card-branch-name" title={branch.branch ?? ""}>
                      {branch.state === "changes"
                        ? `待合并${branch.branch ? ` · ${branch.branch}` : ""}`
                        : branch.state === "conflict"
                          ? `合并冲突：${branch.conflicts.join("、")}`
                          : "冲突已留在主目录，解决并提交后清理"}
                    </span>
                    {branch.state === "changes" && <>
                      <button type="button" disabled={props.pending} onClick={() => props.onMerge(agent.sessionId, "abort")}>合并</button>
                      <button type="button" className="danger-text" disabled={props.pending} onClick={() => props.onDiscard(agent.sessionId)}>丢弃</button>
                    </>}
                    {branch.state === "conflict" && <>
                      <button type="button" disabled={props.pending} onClick={() => props.onMerge(agent.sessionId, "leave")}
                        title="在主目录中重新合并并保留冲突标记，由你解决后提交">我来处理</button>
                      <button type="button" disabled={props.pending} onClick={() => props.onHandoff(agent.sessionId)}
                        title={props.superMode ? "交给 Super Agent 协调子智能体解决冲突" : "把冲突交给主智能体处理"}>交给主智能体</button>
                      <button type="button" className="danger-text" disabled={props.pending} onClick={() => props.onDiscard(agent.sessionId)}>丢弃</button>
                    </>}
                    {branch.state === "resolving" && (
                      <button type="button" disabled={props.pending} onClick={() => props.onDiscard(agent.sessionId)} title="删除子智能体的 worktree 和分支">清理分支</button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
