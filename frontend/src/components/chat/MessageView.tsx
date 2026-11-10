import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatTime } from "../../api";
import type { Message } from "../../types";
import DiagramBlock from "../diagrams/DiagramBlock";
import { diagramFence } from "../diagrams/fence";

const components: Components = {
  pre({ children }) {
    const diagram = diagramFence(children);
    return diagram ? <DiagramBlock {...diagram} /> : <pre>{children}</pre>;
  },
};

export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
}

// A pasted log or spec would otherwise push the rest of the conversation off screen.
const collapsedHeight = 220;
// Folding away only a few lines saves little, so slightly taller messages stay whole.
const collapseAbove = 320;

function Collapsible({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > collapseAbove);
    measure();
    // The inner content changes size with the column width and with diagrams finishing their rendering.
    const observer = new ResizeObserver(measure);
    observer.observe(element.firstElementChild ?? element);
    return () => observer.disconnect();
  }, []);
  const collapsed = overflowing && !expanded;
  function toggle() {
    setExpanded(!expanded);
    // Collapsing from the end of a long message would otherwise leave the reader far below it.
    if (expanded) requestAnimationFrame(() => content.current?.scrollIntoView({ block: "nearest" }));
  }
  return (
    <>
      <div ref={content} className={collapsed ? "message-collapsed" : undefined} style={collapsed ? { maxHeight: collapsedHeight } : undefined}>
        {children}
      </div>
      {overflowing && (
        <button type="button" className="message-expand" aria-expanded={expanded} onClick={toggle}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </>
  );
}

export function AgentAvatar({ engine }: { engine: "claude" | "codex" }) {
  return <span className="agent-avatar"><span className={`engine-logo engine-logo-${engine}`} aria-hidden="true" /></span>;
}

export default function MessageView({
  message,
  username,
  agentName,
  engine,
}: {
  message: Message;
  username: string;
  agentName: string;
  engine: "claude" | "codex";
}) {
  const user = message.role === "user";
  return (
    <article id={`conversation-message-${message.id}`} className={`message message-${message.role}`} tabIndex={-1}>
      <div className="message-author">
        {user ? (
          <span className="mini-avatar">{username.slice(0, 1).toUpperCase()}</span>
        ) : (
          <AgentAvatar engine={engine} />
        )}
        <strong>{user ? "你" : message.role === "assistant" ? agentName : "系统"}</strong>
        <time>{formatTime(message.created_at)}</time>
      </div>
      {user ? (
        <Collapsible>
          <Markdown text={message.content} />
        </Collapsible>
      ) : (
        <Markdown text={message.content} />
      )}
    </article>
  );
}
