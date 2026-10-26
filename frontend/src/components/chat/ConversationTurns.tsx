import { Fragment } from "react";
import { Sparkles } from "lucide-react";
import type { Message, ToolEvent, Turn } from "../../types";
import ExecutionGroup from "./ExecutionGroup";
import MessageView, { Markdown } from "./MessageView";
import TurnProcess from "./TurnProcess";

interface Props {
  messages: Message[];
  turns: Turn[];
  streaming: string;
  tools: ToolEvent[];
  username: string;
  engine?: "claude" | "codex";
}

export default function ConversationTurns(props: Props) {
  const agentName = props.engine === "codex" ? "Codex" : "Claude Code";
  const turnsByUser = new Map(props.turns.map((turn) => [turn.user_message_id, turn]));
  const messageIds = new Set(props.messages.map((message) => message.id));
  const liveTurn = props.turns.some((turn) => turn.status === "running");
  return (
    <>
      {props.messages.map((message) => (
        <Fragment key={message.id}>
          <MessageView message={message} username={props.username} agentName={agentName} />
          {turnsByUser.has(message.id) && <TurnProcess turn={turnsByUser.get(message.id)!} />}
        </Fragment>
      ))}
      {props.turns.filter((turn) => !messageIds.has(turn.user_message_id)).map((turn) => (
        <TurnProcess key={turn.id} turn={turn} />
      ))}
      {!liveTurn && props.streaming && (
        <article className="message message-assistant">
          <div className="message-author">
            <span className="agent-avatar"><Sparkles size={14} /></span>
            <strong>{agentName}</strong>
            <span className="stream-indicator">正在生成</span>
          </div>
          <Markdown text={props.streaming} />
        </article>
      )}
      {props.turns.length === 0 && props.tools.length > 0 && (
        <div className="tools-list"><ExecutionGroup tools={props.tools} /></div>
      )}
    </>
  );
}
