import { ChevronDown, ChevronUp, LoaderCircle, MessageCircleQuestion, Square, Trash2, X } from "lucide-react";
import { formatTime } from "../../../api";
import { engineLabel } from "../../../engines";
import { Markdown } from "../MessageView";
import type { BtwStatus } from "./btwTypes";
import type { SessionBtwControl } from "./useSessionBtw";

const statusText: Record<BtwStatus, string> = {
  running: "回答中",
  completed: "已完成",
  error: "出错",
  cancelled: "已取消",
};

interface Props {
  control: SessionBtwControl;
  readOnly?: boolean;
}

export default function BtwPanel({ control, readOnly }: Props) {
  const { exchanges, collapsed, setCollapsed } = control;
  if (!exchanges.length) return null;

  const runningCount = exchanges.filter((item) => item.status === "running").length;
  const finishedCount = exchanges.length - runningCount;

  return (
    <section className={`btw-panel${collapsed ? " btw-panel-collapsed" : ""}`} aria-label="旁路提问">
      <header className="btw-panel-header">
        <button
          type="button"
          className="btw-panel-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <MessageCircleQuestion size={15} aria-hidden="true" />
          <strong>旁路提问</strong>
          <span className="btw-panel-badge">不计入主上下文</span>
          <span className="btw-panel-count">
            {runningCount > 0 && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
            {runningCount > 0 ? `${runningCount} 条进行中 · 共 ${exchanges.length} 条` : `${exchanges.length} 条`}
          </span>
        </button>
        <div className="btw-panel-actions">
          {!readOnly && finishedCount > 0 && (
            <button
              type="button"
              className="button button-small"
              onClick={() => void control.clearFinished()}
              title="清空已结束的旁路记录"
            >
              <Trash2 size={12} aria-hidden="true" />清空已结束
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "展开旁路提问面板" : "收起旁路提问面板"}
            aria-label={collapsed ? "展开旁路提问面板" : "收起旁路提问面板"}
          >
            {collapsed ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          </button>
        </div>
      </header>
      {!collapsed && (
        <div className="btw-list">
          {exchanges.map((item) => (
            <article key={item.id} className={`btw-item btw-status-${item.status}`}>
              <div className="btw-item-head">
                <div className="btw-item-meta">
                  <span className={`btw-status-pill btw-pill-${item.status}`}>
                    {item.status === "running" && <LoaderCircle size={11} className="spin" aria-hidden="true" />}
                    {statusText[item.status]}
                  </span>
                  <span className="btw-item-engine">
                    {engineLabel(item.engine)}{item.model ? ` · ${item.model}` : ""}
                  </span>
                  <time>{formatTime(item.created_at)}</time>
                </div>
                <div className="btw-item-actions">
                  {item.status === "running" ? (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => void control.cancel(item.id)}
                      title="取消此旁路提问"
                    >
                      <Square size={11} fill="currentColor" aria-hidden="true" />取消
                    </button>
                  ) : !readOnly && (
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void control.remove(item.id)}
                      title="删除此条旁路记录"
                      aria-label="删除此条旁路记录"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
              <div className="btw-question">
                <span className="btw-q-tag">/btw</span>
                <p>{item.question}</p>
              </div>
              <div className="btw-answer">
                {item.answer ? (
                  <Markdown text={item.answer} />
                ) : item.status === "running" ? (
                  <div className="btw-thinking">
                    <span className="thinking-dots"><i /><i /><i /></span>
                    <span>正在基于当前上下文快速回答…</span>
                  </div>
                ) : item.status === "cancelled" ? (
                  <p className="btw-muted">已取消此次旁路提问。</p>
                ) : null}
                {item.error && <p className="btw-error" role="alert">{item.error}</p>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
