import { Archive, MessageCircleQuestion, MessageSquare, MoreHorizontal, Pause, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { isActive } from "../../api";
import type { Session } from "../../types";

interface Props {
  session: Session;
  selected: boolean;
  waiting: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onSelect: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Shown beside the title, such as the toggle of a master's child agents. */
  accessory?: ReactNode;
}

export default function SessionRow({ session, selected, waiting, menuOpen, onToggleMenu, onSelect, onRename, onArchive, onDelete, accessory }: Props) {
  return (
    <div className={`session-row ${selected ? "selected" : ""}`}>
      <button className="tree-row" onClick={onSelect}>
        {session.status === "paused" ? (
          <Pause size={13} aria-label="已暂停" />
        ) : isActive(session.status) ? (
          <span className="running-dot" />
        ) : waiting ? (
          <MessageCircleQuestion size={13} className="session-waiting" aria-label="有待回答的问题" />
        ) : (
          <MessageSquare size={13} />
        )}
        <span>{session.agent_name && session.parent_session_id ? <><strong className="session-agent-name">{session.agent_name}</strong> {session.title.replace(`${session.agent_name} · `, "")}</> : session.title}</span>
      </button>
      {accessory}
      <div className="row-menu-anchor">
        <button className="icon-button hover-action" onClick={onToggleMenu} aria-label="对话操作">
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div className="context-menu">
            <button onClick={onRename}>重命名</button>
            <button disabled={isActive(session.status)} title={isActive(session.status) ? "请先停止对话再归档" : undefined} onClick={onArchive}>
              <Archive size={14} />
              归档对话
            </button>
            <button className="danger-text" onClick={onDelete}>
              <Trash2 size={14} />
              删除对话
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
