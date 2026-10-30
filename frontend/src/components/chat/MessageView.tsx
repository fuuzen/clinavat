import { Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTime } from "../../api";
import type { Message } from "../../types";

export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
}

export default function MessageView({
  message,
  username,
  agentName,
}: {
  message: Message;
  username: string;
  agentName: string;
}) {
  const user = message.role === "user";
  return (
    <article id={`conversation-message-${message.id}`} className={`message message-${message.role}`} tabIndex={-1}>
      <div className="message-author">
        {user ? (
          <span className="mini-avatar">{username.slice(0, 1).toUpperCase()}</span>
        ) : (
          <span className="agent-avatar"><Sparkles size={14} /></span>
        )}
        <strong>{user ? "你" : message.role === "assistant" ? agentName : "系统"}</strong>
        <time>{formatTime(message.created_at)}</time>
      </div>
      <Markdown text={message.content} />
    </article>
  );
}
