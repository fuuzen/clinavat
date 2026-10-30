import { Fragment } from "react";
import { Sparkles } from "lucide-react";
import type { Message, ToolEvent, Turn } from "../../types";
import ExecutionGroup from "./ExecutionGroup";
import MessageView, { Markdown } from "./MessageView";
import TurnProcess from "./TurnProcess";
import { isActive } from "../../api";

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
  const messageIds = new Set(props.messages.map((message) => message.id));
  const turnsByMessage = new Map<string, Turn[]>();
  const previousByUser = new Map<string, Turn>();
  for (const turn of props.turns) {
    const previousAnswer = previousByUser.get(turn.user_message_id)?.assistant_message_id;
    const anchor = messageIds.has(turn.user_message_id) && previousAnswer && messageIds.has(previousAnswer)
      ? previousAnswer : turn.user_message_id;
    const anchored = turnsByMessage.get(anchor) ?? [];
    anchored.push(turn);
    turnsByMessage.set(anchor, anchored);
    previousByUser.set(turn.user_message_id, turn);
  }
  const liveTurn = props.turns.some((turn) => isActive(turn.status));
  return (
    <>
      {props.messages.map((message) => (
        <Fragment key={message.id}>
          <MessageView message={message} username={props.username} agentName={agentName} />
          {turnsByMessage.get(message.id)?.map(turn => <TurnProcess key={turn.id} turn={turn} />)}
        </Fragment>
      ))}
      {props.turns.filter((turn) => !messageIds.has(turn.user_message_id)).map((turn) => (
        <div key={turn.id} id={`conversation-turn-${turn.id}`} className="conversation-turn-anchor" tabIndex={-1}>
          <TurnProcess turn={turn} />
        </div>
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
