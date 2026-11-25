import { GitBranch } from "lucide-react";
import { useLinkedSession } from "../../hooks/useSelectedSession";
import type { Session } from "../../types";

/** Heads a branch: earlier messages were copied from its source, while the project's files were not rolled back. */
export default function ForkOrigin({ session, sessions, onOpen }: { session: Session; sessions: Session[]; onOpen: (source: Session | string) => void }) {
  const { session: source, missing } = useLinkedSession(session.forked_from_session_id, sessions);
  if (!session.forked_from_session_id) return null;
  const sourceLabel = source
    ? `「${source.title}」${source.archived_at ? "（已归档）" : ""}`
    : missing
      ? "一个已删除的对话"
      : "原对话";
  return (
    <div className="fork-origin">
      <GitBranch size={13} aria-hidden="true" />
      <span>
        分支自{sourceLabel}，之前的消息复制自原对话。
        分支只复制对话上下文，项目文件不会回到分支点。
      </span>
      {!missing && (
        <button type="button" className="text-button" onClick={() => onOpen(source ?? session.forked_from_session_id!)}>打开原对话</button>
      )}
    </div>
  );
}
