import { useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import type { Overview, Project, Session } from "../../types";

interface Props {
  overview: Overview;
  selectedSessionId?: string;
  readOnly?: boolean;
  matches: (value: string) => boolean;
  menu: string;
  onMenu: (id: string) => void;
  onSelect: (project: Project, session: Session) => void;
  onRestore: (session: Session) => void;
  onDelete: (session: Session) => void;
}

/** Archived conversations stay readable here, most recently archived first, until restored or deleted. */
export default function ArchivedSessions({ overview, selectedSessionId, readOnly, matches, menu, onMenu, onSelect, onRestore, onDelete }: Props) {
  const readOnlyTip = "系统维护中，暂不支持修改对话";
  const [open, setOpen] = useState(false);
  const projects = new Map(overview.projects.map((project) => [project.id, project]));
  const archived = overview.sessions
    .filter((session) => session.archived_at && projects.has(session.project_id))
    .sort((left, right) => (right.archived_at ?? "").localeCompare(left.archived_at ?? ""));
  const visible = archived.filter((session) => matches(session.title) || matches(projects.get(session.project_id)!.name));
  if (!visible.length) return null;
  return (
    <div className="archived-sessions">
      <button className="tree-row archived-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Archive size={13} />
        <span>已归档</span>
        <small>{visible.length}</small>
      </button>
      {open && visible.map((session) => {
        const project = projects.get(session.project_id)!;
        const menuKey = `archived:${session.id}`;
        return (
          <div key={session.id} className={`session-row ${selectedSessionId === session.id ? "selected" : ""}`}>
            <button className="tree-row" onClick={() => onSelect(project, session)}>
              <Archive size={13} />
              <span>{session.title}</span>
              <small>{project.name}</small>
            </button>
            <div className="row-menu-anchor">
              <button className="icon-button hover-action" onClick={() => onMenu(menu === menuKey ? "" : menuKey)} aria-label="已归档对话操作">
                <MoreHorizontal size={13} />
              </button>
              {menu === menuKey && (
                <div className="context-menu">
                  <button disabled={readOnly} title={readOnly ? readOnlyTip : undefined} onClick={() => { onRestore(session); onMenu(""); }}>
                    <ArchiveRestore size={14} />
                    恢复对话
                  </button>
                  <button className="danger-text" disabled={readOnly} title={readOnly ? readOnlyTip : undefined} onClick={() => { onDelete(session); onMenu(""); }}>
                    <Trash2 size={14} />
                    删除对话
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
