import { MessagesSquare, Square } from "lucide-react";
import type { DiscussionFormat, DiscussionView, Session } from "../../../types";

export const formatNames: Record<DiscussionFormat, string> = { council: "圆桌", debate: "辩论", review: "评审" };

function progress(discussion: DiscussionView): string {
  if (discussion.status === "running") return discussion.rounds > 1 ? `第 ${discussion.round}/${discussion.rounds} 轮` : "进行中";
  if (discussion.status === "completed") return "已完成";
  if (discussion.status === "stopped") return "已停止";
  return `出错${discussion.detail ? `：${discussion.detail}` : ""}`;
}

/** A discussion in the agent panel: its round, and each participant's state in it. */
export default function DiscussionCard({ discussion, sessions, pending, onOpen, onStop }: {
  discussion: DiscussionView;
  sessions: Session[];
  pending: boolean;
  onOpen: (session: Session) => void;
  onStop: (id: string) => void;
}) {
  const running = discussion.status === "running";
  return (
    <div className={`agent-card discussion-card discussion-${discussion.status}`}>
      <div className="agent-card-row">
        <MessagesSquare size={13} aria-hidden="true" />
        <span className="discussion-format">{formatNames[discussion.format]}</span>
        <span className="agent-card-meta" title={discussion.topic}>{discussion.topic}</span>
        <span className={`agent-card-state agent-state-${running ? "running" : discussion.status === "completed" ? "done" : discussion.status === "error" ? "error" : "idle"}`}
          title={discussion.detail ?? undefined}>{progress(discussion)}</span>
        {running && (
          <button type="button" className="agent-card-stop" disabled={pending} onClick={() => onStop(discussion.id)} title="停止讨论和所有参与者" aria-label="停止讨论">
            <Square size={10} fill="currentColor" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="discussion-participants">
        {discussion.participants.map((participant) => {
          const spoke = participant.statements.find((statement) => statement.round === discussion.round);
          const state = participant.running ? "running" : spoke?.status === "completed" ? "done" : spoke ? "error" : "idle";
          const session = sessions.find((item) => item.id === participant.sessionId);
          return (
            <button key={participant.sessionId} type="button" className={`discussion-participant participant-${state}`} disabled={!session}
              onClick={() => session && onOpen(session)} title={`${participant.name}${participant.stance ? `（${participant.stance}）` : ""} · ${participant.model || "默认模型"}`}>
              <span className={`engine-logo engine-logo-${participant.engine}`} aria-hidden="true" />
              {participant.name.replace(/^d\d+-/, "")}
              {participant.stance && <small>{participant.stance}</small>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
