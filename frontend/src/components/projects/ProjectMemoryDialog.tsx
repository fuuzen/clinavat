import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookMarked, Check, ChevronLeft, ChevronRight, Copy, Home, LoaderCircle, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, errorText, formatTime } from "../../api";
import type { MemoryEntryView, Project } from "../../types";

interface Props {
  project: Project;
  standalone?: boolean;
  refreshTick?: number;
  onClose: () => void;
  onFocusMain?: () => void;
  onNotice: (message: string, kind?: "error" | "success") => void;
  onChanged?: () => void;
}

const pageSize = 5;

function highlightText(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, index) =>
    part.toLowerCase() === trimmed.toLowerCase()
      ? <mark key={index} className="memory-highlight">{part}</mark>
      : part,
  );
}

export default function ProjectMemoryDialog({
  project,
  standalone = false,
  refreshTick = 0,
  onClose,
  onFocusMain,
  onNotice,
  onChanged,
}: Props) {
  const [entries, setEntries] = useState<MemoryEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const list = await api<MemoryEntryView[]>(`/projects/${project.id}/memories`, { signal });
      if (!signal?.aborted) setEntries(list);
    } catch (cause) {
      if (!signal?.aborted) setError(errorText(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshTick]);

  useEffect(() => {
    if (standalone) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, standalone]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return entries;
    return entries.filter((entry) =>
      entry.key.toLowerCase().includes(keyword) || entry.content.toLowerCase().includes(keyword),
    );
  }, [entries, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  async function copyEntry(entry: MemoryEntryView) {
    try {
      await navigator.clipboard.writeText(`${entry.key}\n${entry.content}`);
      setCopiedKey(entry.key);
      window.setTimeout(() => setCopiedKey((current) => (current === entry.key ? null : current)), 1800);
    } catch {
      onNotice("复制失败，请手动选择文本");
    }
  }

  async function removeEntry(key: string) {
    setDeletingKey(key);
    try {
      const next = await api<MemoryEntryView[]>(`/projects/${project.id}/memories/${encodeURIComponent(key)}`, { method: "DELETE" });
      setEntries(next);
      onChanged?.();
      onNotice(`已删除项目记忆「${key}」`, "success");
    } catch (cause) {
      onNotice(errorText(cause));
    } finally {
      setDeletingKey(null);
    }
  }

  const panel = (
    <div
      className={standalone ? "detached-window-surface detached-memory-window memory-modal" : "modal modal-wide memory-modal"}
      role={standalone ? undefined : "dialog"}
      aria-modal={standalone ? undefined : "true"}
      aria-label={`${project.name} 项目记忆`}
    >
      <div className={standalone ? "detached-window-header" : "modal-header"}>
        <div>
          <h2 className="memory-modal-heading">
            <BookMarked size={18} aria-hidden="true" />
            <span>项目记忆</span>
            <span className="badge">{project.name}</span>
          </h2>
          <p>跨对话持久化保存的项目约定、架构边界与关键决策，上下文压缩或无感续接后仍可继承。</p>
        </div>
        <div className={standalone ? "detached-window-actions" : undefined}>
          {standalone && onFocusMain && (
            <button type="button" className="button button-ghost button-small" onClick={onFocusMain}>
              <Home size={14} aria-hidden="true" />
              回到主窗口
            </button>
          )}
          <button type="button" className="icon-button" onClick={onClose} aria-label={standalone ? "关闭窗口" : "关闭项目记忆"}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="memory-modal-toolbar">
        <div className="memory-search-box">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="检索记忆键名或内容…"
            aria-label="检索项目记忆"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
          {query && (
            <button type="button" className="icon-button" onClick={() => { setQuery(""); setPage(1); }} aria-label="清除检索">
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="memory-modal-count">
          {query.trim() ? `匹配 ${filtered.length} / ${entries.length} 条` : `共 ${entries.length} 条`}
        </span>
        <button
          type="button"
          className="icon-button"
          disabled={loading}
          onClick={() => void load()}
          title="刷新项目记忆"
          aria-label="刷新项目记忆"
        >
          <RefreshCw size={14} className={loading ? "spin" : undefined} aria-hidden="true" />
        </button>
      </div>

      <div className="memory-modal-body">
        {loading ? (
          <div className="loading-state">
            <LoaderCircle size={18} className="spin" aria-hidden="true" />
            <span>正在加载项目记忆…</span>
          </div>
        ) : error ? (
          <div className="inline-error">{error}</div>
        ) : entries.length === 0 ? (
          <div className="memory-empty">
            <BookMarked size={24} aria-hidden="true" />
            <strong>暂无项目记忆</strong>
            <p>在协作编排或 Super Agent 对话中，主智能体会自动记录架构约束与关键决策到此项目。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="memory-empty">
            <Search size={22} aria-hidden="true" />
            <strong>未找到匹配的记忆条目</strong>
            <p>没有包含「{query.trim()}」的键名或内容。</p>
            <button type="button" className="button button-secondary button-small" onClick={() => { setQuery(""); setPage(1); }}>
              清除检索条件
            </button>
          </div>
        ) : (
          <div className="memory-modal-list">
            {visible.map((entry) => (
              <article key={entry.key} className="memory-modal-item">
                <div className="memory-modal-item-head">
                  <code className="memory-modal-key">{highlightText(entry.key, query)}</code>
                  <time className="memory-modal-time" title={entry.updatedAt}>{formatTime(entry.updatedAt)}</time>
                  <div className="memory-modal-item-actions">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void copyEntry(entry)}
                      title={copiedKey === entry.key ? "已复制" : "复制记忆内容"}
                      aria-label={`复制记忆 ${entry.key}`}
                    >
                      {copiedKey === entry.key ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="icon-button danger-text"
                      disabled={deletingKey === entry.key}
                      onClick={() => void removeEntry(entry.key)}
                      title={`删除记忆 ${entry.key}`}
                      aria-label={`删除记忆 ${entry.key}`}
                    >
                      {deletingKey === entry.key ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
                    </button>
                  </div>
                </div>
                <pre className="memory-modal-content">{highlightText(entry.content, query)}</pre>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="memory-modal-footer">
        <span className="memory-modal-page-info">
          {filtered.length > 0 ? `第 ${safePage} / ${totalPages} 页 · 每页 ${pageSize} 条` : "0 条记忆"}
        </span>
        {totalPages > 1 && (
          <div className="memory-pagination" role="navigation" aria-label="项目记忆分页">
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft size={13} aria-hidden="true" />
              上一页
            </button>
            <div className="memory-page-numbers">
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((num) => (
                <button
                  key={num}
                  type="button"
                  className={`memory-page-btn${num === safePage ? " active" : ""}`}
                  aria-current={num === safePage ? "page" : undefined}
                  onClick={() => setPage(num)}
                >
                  {num}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
            >
              下一页
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (standalone) return panel;

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {panel}
    </div>
  );
}
