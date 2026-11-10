import { GitBranch } from "lucide-react";
import type { Session } from "../../types";

/** Heads a branch: earlier messages were copied from its source, while the project's files were not rolled back. */
export default function ForkOrigin({ session, sessions, onOpen }: { session: Session; sessions: Session[]; onOpen: (source: Session) => void }) {
  if (!session.forked_from_session_id) return null;
  const source = sessions.find((item) => item.id === session.forked_from_session_id);
  return (
    <div className="fork-origin">
      <GitBranch size={13} aria-hidden="true" />
      <span>
        分支自{source ? `「${source.title}」` : "一个已删除的对话"}，之前的消息复制自原对话。
        分支只复制对话上下文，项目文件不会回到分支点。
      </span>
      {source && <button type="button" className="text-button" onClick={() => onOpen(source)}>打开原对话</button>}
    </div>
  );
}
