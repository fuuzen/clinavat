import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Message, Turn } from "../../types";
import { useConversationOutline } from "./useConversationOutline";
import "../../styles/conversation-outline.css";

interface Props {
  messages: Message[];
  turns: Turn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
}

const statusNames: Record<Turn["status"], string> = {
  running: "正在回复…",
  pausing: "正在暂停…",
  paused: "本轮已暂停",
  completed: "本轮已完成",
  interrupted: "本轮已停止",
  error: "本轮出错",
};

function displayDate(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString(undefined, {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function ConversationOutline({ messages, turns, scrollRef, onNavigate }: Props) {
  const { entries, currentId, setCurrentId } = useConversationOutline(messages, turns, scrollRef);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState(0);
  const outlineRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const pointerType = useRef("");
  const touchPreviewId = useRef<string | null>(null);
  const previewDomId = useId();
  const previewIndex = entries.findIndex((entry) => entry.id === previewId);
  const preview = entries[previewIndex];
  const tabId = previewId || currentId || entries[0]?.id;

  function cancelClose() { window.clearTimeout(closeTimer.current); }
  function close() {
    cancelClose();
    touchPreviewId.current = null;
    setPreviewId(null);
  }
  function show(id: string) {
    cancelClose();
    setPreviewId(id);
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = window.setTimeout(close, 140);
  }

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!previewId) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !outlineRef.current?.contains(event.target)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (previewRef.current?.contains(document.activeElement)) {
        listRef.current?.querySelector<HTMLAnchorElement>('a[tabindex="0"]')?.focus({ preventScroll: true });
      }
      close();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [previewId]);

  useLayoutEffect(() => {
    const root = outlineRef.current;
    const card = previewRef.current;
    const list = listRef.current;
    if (!root || !card || !list || !previewId) return;
    const position = () => {
      const link = Array.from(list.querySelectorAll<HTMLAnchorElement>("a")).find((item) => item.dataset.entryId === previewId);
      if (!link) return;
      const line = link.getBoundingClientRect();
      const top = line.top + line.height / 2 - root.getBoundingClientRect().top - card.offsetHeight / 2;
      setPreviewTop(Math.max(0, Math.min(top, root.clientHeight - card.offsetHeight)));
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(root);
    observer.observe(card);
    list.addEventListener("scroll", position, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener("scroll", position); };
  }, [previewId]);

  useEffect(() => {
    if (previewId) return;
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !active) return;
    const top = active.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + active.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + active.offsetHeight - list.clientHeight;
    }
  }, [currentId, previewId]);

  function navigate(id: string) {
    const scroll = scrollRef.current;
    const target = document.getElementById(id);
    if (!scroll || !target || !scroll.contains(target)) return;
    onNavigate();
    close();
    // Stop following new output before scrolling; animation can re-enable following near the bottom.
    window.requestAnimationFrame(() => {
      if (!target.isConnected) return;
      scroll.scrollTo({ top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20, behavior: "instant" });
      target.focus({ preventScroll: true });
      setCurrentId(id);
    });
  }

  if (!entries.length) return null;
  return (
    <aside
      ref={outlineRef}
      className={`conversation-outline${preview ? " outline-engaged" : ""}`}
      aria-label="对话大纲"
      onPointerEnter={cancelClose}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") scheduleClose(); }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <nav className="outline-rail" aria-label={`历史对话，共 ${entries.length} 轮`}>
        <ol ref={listRef} className="outline-marks">
          {entries.map((entry, index) => (
            <li key={entry.id}>
              <a
                className="outline-mark"
                href={`#${entry.id}`}
                data-entry-id={entry.id}
                data-distance={preview ? Math.min(2, Math.abs(index - previewIndex)) : undefined}
                aria-label={`第 ${index + 1} 轮：${entry.label}`}
                aria-current={entry.id === currentId ? "location" : undefined}
                aria-expanded={entry.id === previewId}
                aria-controls={entry.id === previewId ? previewDomId : undefined}
                tabIndex={entry.id === tabId ? 0 : -1}
                onPointerEnter={(event) => { if (event.pointerType === "mouse") show(entry.id); }}
                onPointerDown={(event) => { pointerType.current = event.pointerType; }}
                onFocus={() => { if (pointerType.current !== "touch") show(entry.id); }}
                onClick={(event) => {
                  event.preventDefault();
                  if (pointerType.current === "touch" && touchPreviewId.current !== entry.id) {
                    touchPreviewId.current = entry.id;
                    show(entry.id);
                  } else navigate(entry.id);
                  pointerType.current = "";
                }}
                onKeyDown={(event) => {
                  pointerType.current = "";
                  let next = index;
                  if (event.key === "ArrowDown") next = Math.min(entries.length - 1, index + 1);
                  else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = entries.length - 1;
                  else if (event.key === " ") { event.preventDefault(); navigate(entry.id); return; }
                  else return;
                  event.preventDefault();
                  const link = listRef.current?.querySelectorAll<HTMLAnchorElement>("a")[next];
                  link?.focus({ preventScroll: true });
                  link?.scrollIntoView({ block: "nearest", behavior: "instant" });
                }}
              >
                <span aria-hidden="true" />
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {preview && (
        <div ref={previewRef} id={previewDomId} className="outline-preview" style={{ top: previewTop }}>
          <button type="button" className="outline-preview-card" onClick={() => navigate(preview.id)} aria-label={`跳转到第 ${previewIndex + 1} 轮：${preview.label}`}>
            <strong className="outline-preview-title">{preview.label}</strong>
            <span className="outline-preview-answer">{preview.preview || (preview.status ? statusNames[preview.status] : "暂无回复")}</span>
            <span className="outline-preview-meta">
              <span>{previewIndex + 1} / {entries.length}</span>
              <time>{displayDate(preview.createdAt)}</time>
              <ArrowUpRight size={14} aria-hidden="true" />
            </span>
          </button>
        </div>
      )}
    </aside>
  );
}
