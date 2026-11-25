import { useEffect, useMemo, useState } from "react";
import {
  Archive, ArchiveRestore, ChevronLeft, ChevronRight, ExternalLink,
  Folder, LoaderCircle, MessagesSquare, Search, Trash2, Workflow, X,
} from "lucide-react";
import { api, errorText, fetchArchivedSessions } from "../../api";
import { engineLabel } from "../../engines";
import type { ArchivedSessionItem, ArchivedSessionKind, ArchivedSessionsResponse, Overview, Session } from "../../types";
import { ConfirmDialog } from "../Dialogs";

const PAGE_SIZE = 20;
const MAINTENANCE_TIP = "系统维护中，暂不支持修改对话";
const KIND_OPTIONS: { value: ArchivedSessionKind; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "primary", label: "主对话" },
  { value: "child", label: "子智能体" },
];

function formatArchivedAt(timestamp?: string | null): string {
  if (!timestamp) return "—";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(timestamp) ? `${timestamp.replace(" ", "T")}Z` : timestamp;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

interface Props {
  overview: Overview;
  onOpen: (session: ArchivedSessionItem) => void;
  onRestore: (session: Session) => Promise<boolean>;
  onDeleted: (sessionId: string) => void;
}

export default function ArchivedSessionsSettings({ overview, onOpen, onRestore, onDeleted }: Props) {
  const maintenance = !!overview.maintenance?.enabled;
  const [queryInput, setQueryInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  // Legacy sidebar ArchivedSessions listed all archived sessions without hiding child agents.
  const [kind, setKind] = useState<ArchivedSessionKind>("all");
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);
  const [data, setData] = useState<ArchivedSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ArchivedSessionItem | null>(null);

  const rootProjects = useMemo(() => overview.projects.filter((project) => !project.parent_project_id), [overview.projects]);
  const projectNames = useMemo(() => new Map(overview.projects.map((project) => [project.id, project.name])), [overview.projects]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = queryInput.trim();
      setDebouncedQuery((previous) => {
        if (previous !== next) setPage(1);
        return next;
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchArchivedSessions(
      { page, pageSize: PAGE_SIZE, q: debouncedQuery || undefined, projectId: projectId || undefined, kind },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.items.length === 0 && page > 1 && result.totalPages > 0 && page > result.totalPages) {
          setPage(result.totalPages);
          return;
        }
        setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, debouncedQuery, projectId, kind, reloadTick]);

  const refreshAfterMutation = () => {
    if ((data?.items.length ?? 0) <= 1 && page > 1) setPage((current) => Math.max(1, current - 1));
    else setReloadTick((value) => value + 1);
  };

  async function handleRestore(item: ArchivedSessionItem) {
    if (maintenance || restoringId) return;
    setRestoringId(item.id);
    try {
      if (await onRestore(item)) refreshAfterMutation();
    } finally {
      setRestoringId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const targetId = deleting.id;
    await api(`/sessions/${targetId}`, { method: "DELETE" });
    onDeleted(targetId);
    refreshAfterMutation();
  }

  const hasFilters = Boolean(debouncedQuery || projectId || kind !== "all");
  const totalPages = data?.totalPages ?? 0;

  return (
    <div className="archived-settings">
      <div className="settings-section-heading">
        <Archive size={17} />
        <h3>已归档对话</h3>
      </div>
      <p className="settings-description">
        归档后的对话会从侧栏移至此处按归档时间倒序保存；你可以随时搜索、只读打开、恢复继续对话或彻底删除。
      </p>

      <div className="archived-toolbar">
        <div className="archived-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={queryInput}
            placeholder="搜索已归档对话标题或内容…"
            aria-label="搜索已归档对话"
            onChange={(event) => setQueryInput(event.target.value)}
          />
          {queryInput && (
            <button type="button" className="icon-button" aria-label="清除搜索"
              onClick={() => { setQueryInput(""); setDebouncedQuery(""); setPage(1); }}>
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <select className="archived-project-select" aria-label="按项目筛选" value={projectId}
          onChange={(event) => { setProjectId(event.target.value); setPage(1); }}>
          <option value="">全部项目</option>
          {rootProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <div className="archived-kind-group" role="group" aria-label="按对话类型筛选">
          {KIND_OPTIONS.map((option) => (
            <button key={option.value} type="button" className={kind === option.value ? "active" : ""}
              onClick={() => { setKind(option.value); setPage(1); }}>
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="inline-error archived-error" role="alert">
          <span>{error}</span>
          <button type="button" className="button button-ghost button-small" onClick={() => setReloadTick((value) => value + 1)}>
            重试
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="loading-state">
          <LoaderCircle size={18} className="spin" />
          <span>正在加载已归档对话…</span>
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="settings-empty">
          <Archive size={26} />
          <strong>{hasFilters ? "没有匹配的已归档对话" : "暂无已归档对话"}</strong>
          <p>{hasFilters ? "尝试调整搜索关键词、项目或对话类型筛选条件。" : "在侧栏归档的对话以及自动归档的子对话都会集中保存在这里。"}</p>
        </div>
      ) : (
        <div className={`archived-list${loading ? " is-loading" : ""}`}>
          {data?.items.map((item) => {
            const projectName = item.project_name
              || projectNames.get(item.root_project_id || item.project_id)
              || projectNames.get(item.project_id) || "未知项目";
            const isDiscussion = Boolean(item.discussion_id);
            const isChild = !isDiscussion && Boolean(item.parent_session_id || item.agent_name);
            const busy = restoringId === item.id;
            return (
              <div key={item.id} className="archived-item">
                <div className="archived-item-main">
                  <div className="archived-item-title-row">
                    <span className={`engine-logo engine-logo-${item.engine}`} title={engineLabel(item.engine)} aria-hidden="true" />
                    <button type="button" className="archived-item-title" onClick={() => onOpen(item)} title={item.title}>
                      {item.title}
                    </button>
                  </div>
                  <div className="archived-item-meta">
                    <span className="archived-meta-project" title={projectName}>
                      <Folder size={12} aria-hidden="true" />
                      {projectName}
                    </span>
                    <span className="archived-meta-badge">{engineLabel(item.engine)}</span>
                    {isDiscussion && (
                      <span className="archived-meta-badge archived-badge-discussion">
                        <MessagesSquare size={11} aria-hidden="true" />
                        讨论{item.discussion_stance ? ` · ${item.discussion_stance}` : ""}
                      </span>
                    )}
                    {isChild && (
                      <span className="archived-meta-badge archived-badge-child">
                        <Workflow size={11} aria-hidden="true" />
                        子智能体{item.agent_name ? ` · ${item.agent_name}` : ""}
                      </span>
                    )}
                    <span className="archived-meta-time">归档于 {formatArchivedAt(item.archived_at)}</span>
                  </div>
                </div>
                <div className="archived-item-actions">
                  <button type="button" className="button button-ghost button-small" onClick={() => onOpen(item)}>
                    <ExternalLink size={12} aria-hidden="true" />
                    打开
                  </button>
                  <button type="button" className="button button-secondary button-small"
                    disabled={maintenance || busy} title={maintenance ? MAINTENANCE_TIP : "恢复对话"}
                    onClick={() => void handleRestore(item)}>
                    {busy ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <ArchiveRestore size={12} aria-hidden="true" />}
                    恢复
                  </button>
                  <button type="button" className="icon-button danger-text"
                    disabled={maintenance || busy} title={maintenance ? MAINTENANCE_TIP : "删除对话"}
                    aria-label={`删除 ${item.title}`} onClick={() => setDeleting(item)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="archived-pagination">
          <span className="archived-pagination-total">共 {data.total} 条</span>
          <div className="archived-pagination-controls">
            <button type="button" className="button button-ghost button-small"
              disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              <ChevronLeft size={13} aria-hidden="true" />
              上一页
            </button>
            <span className="archived-pagination-page">{data.page} / {Math.max(1, totalPages)}</span>
            <button type="button" className="button button-ghost button-small"
              disabled={loading || page >= totalPages} onClick={() => setPage((current) => current + 1)}>
              下一页
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog name={deleting.title} kind="对话" onClose={() => setDeleting(null)} onConfirm={confirmDelete} />
      )}
    </div>
  );
}
