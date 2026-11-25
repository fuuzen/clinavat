import { Workflow } from "lucide-react";
import { useLinkedSession } from "../../../hooks/useSelectedSession";
import type { Session } from "../../../types";

/** Heads a child agent's conversation: who started it, and what it may do. */
export default function AgentOrigin({ session, sessions, onOpen }: { session: Session; sessions: Session[]; onOpen: (master: Session | string) => void }) {
  const { session: master, missing } = useLinkedSession(session.parent_session_id, sessions);
  if (!session.parent_session_id && !session.agent_name) return null;
  const masterLabel = master
    ? `「${master.title}」${master.archived_at ? "（已归档）" : ""}`
    : missing || !session.parent_session_id
      ? "一个已删除的对话"
      : "主对话";
  return (
    <div className="fork-origin agent-origin">
      <Workflow size={13} aria-hidden="true" />
      <span>
        子智能体「{session.agent_name}」，{session.agent_access === "read" ? "只读" : session.agent_isolation === "worktree"
          ? "在自己的 Git worktree 和分支中修改，完成后由主智能体或你合并" : "直接修改项目文件"}
        {session.agent_directory ? `，只能修改 ${session.agent_directory} 中的文件` : ""}，
        由{masterLabel}的主智能体派生。它的最终回复会作为汇报交给主智能体；
        你也可以直接在这里与它对话，主智能体发来的消息不代表你的授权。
      </span>
      {session.parent_session_id && !missing && (
        <button type="button" className="text-button" onClick={() => onOpen(master ?? session.parent_session_id!)}>打开主对话</button>
      )}
    </div>
  );
}
