import { Workflow } from "lucide-react";
import type { Session } from "../../../types";

/** Heads a child agent's conversation: who started it, and what it may do. */
export default function AgentOrigin({ session, sessions, onOpen }: { session: Session; sessions: Session[]; onOpen: (master: Session) => void }) {
  if (!session.parent_session_id && !session.agent_name) return null;
  const master = sessions.find((item) => item.id === session.parent_session_id);
  return (
    <div className="fork-origin agent-origin">
      <Workflow size={13} aria-hidden="true" />
      <span>
        子智能体「{session.agent_name}」，{session.agent_access === "read" ? "只读" : "可修改项目文件"}，
        由{master ? `「${master.title}」` : "一个已删除的对话"}的主智能体派生。它的最终回复会作为汇报交给主智能体；
        你也可以直接在这里与它对话，主智能体发来的消息不代表你的授权。
      </span>
      {master && <button type="button" className="text-button" onClick={() => onOpen(master)}>打开主对话</button>}
    </div>
  );
}
