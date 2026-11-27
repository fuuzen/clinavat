import { Fragment, type ReactNode } from "react";
import type { Message, ToolEvent, Turn } from "../../types";
import ExecutionGroup from "./ExecutionGroup";
import MessageView, { AgentAvatar, Markdown } from "./MessageView";
import TurnProcess from "./TurnProcess";
import AutonomousRunGroup, { CycleNoticeFrame } from "./agents/AutonomousRunGroup";
import { buildConversationBlocks } from "./agents/autonomousRuns";
import { planConversationTurns } from "./native/turnSegments";
import { isActive } from "../../api";
import { engineLabel, type AgentEngine } from "../../engines";

interface Props {
  messages: Message[];
  turns: Turn[];
  streaming: string;
  tools: ToolEvent[];
  username: string;
  engine?: AgentEngine;
  onFork?: (turn: Turn) => void;
}

const finished = new Set<Turn["status"]>(["completed", "interrupted", "error"]);

export default function ConversationTurns(props: Props) {
  const engine = props.engine ?? "claude";
  const agentName = engineLabel(engine);
  const plan = planConversationTurns(props.messages, props.turns);
  const liveTurn = props.turns.some((turn) => isActive(turn.status));
  const forkable = new Map(props.turns.filter((turn) => turn.assistant_message_id && turn.native_ref && finished.has(turn.status))
    .map((turn) => [turn.assistant_message_id!, turn]));
  const { onFork } = props;
  const renderMessage = (message: Message): ReactNode => (
    <Fragment key={message.id}>
      {plan.beforeMessage.get(message.id)?.map((segment) => (
        <TurnProcess key={segment.key} turn={segment.turn} segment={segment} />
      ))}
      <MessageView message={message} username={props.username} agentName={agentName} engine={engine}
        pendingSteer={plan.pendingSteerMessageIds.has(message.id)}
        onFork={onFork && forkable.has(message.id) ? () => onFork(forkable.get(message.id)!) : undefined} />
      {plan.afterMessage.get(message.id)?.map((segment) => (
        <TurnProcess key={segment.key} turn={segment.turn} segment={segment} />
      ))}
    </Fragment>
  );
  return (
    <>
      {buildConversationBlocks(props.messages, plan.turnsByMessage).map((block) => {
        const key = block.kind === "run" ? block.cycles[0].messages[0].id : block.messages[0].id;
        if (block.kind === "run") {
          return <AutonomousRunGroup key={key} cycles={block.cycles}>{block.cycles.flatMap((cycle) => cycle.messages).map(renderMessage)}</AutonomousRunGroup>;
        }
        return block.notice
          ? <CycleNoticeFrame key={key} notice={block.notice}>{block.messages.map(renderMessage)}</CycleNoticeFrame>
          : <Fragment key={key}>{block.messages.map(renderMessage)}</Fragment>;
      })}
      {plan.unanchoredTurns.map((turn) => (
        <div key={turn.id} id={`conversation-turn-${turn.id}`} className="conversation-turn-anchor" tabIndex={-1}>
          <TurnProcess turn={turn} />
        </div>
      ))}
      {!liveTurn && props.streaming && (
        <article className="message message-assistant">
          <div className="message-author">
            <AgentAvatar engine={engine} />
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
