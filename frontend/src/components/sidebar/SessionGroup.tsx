import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { Session } from "../../types";

export interface SessionGroupEntry { session: Session; children: Session[] }

/** Child agents follow their master; a child whose master is gone or not listed stands on its own. */
export function groupSessions(sessions: Session[]): SessionGroupEntry[] {
  const listed = new Set(sessions.map((session) => session.id));
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parent_session_id || !listed.has(session.parent_session_id)) continue;
    children.set(session.parent_session_id, [...(children.get(session.parent_session_id) ?? []), session]);
  }
  return sessions.filter((session) => !session.parent_session_id || !listed.has(session.parent_session_id))
    .map((session) => ({ session, children: children.get(session.id) ?? [] }));
}

/** A conversation with its child agents folded below it; they unfold while one of them is open. */
export default function SessionGroup({ entry, selectedId, renderRow }: {
  entry: SessionGroupEntry;
  selectedId?: string;
  renderRow: (session: Session, accessory?: ReactNode) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || entry.children.some((child) => child.id === selectedId);
  const toggle = entry.children.length > 0 && (
    <button type="button" className={`session-children-toggle ${expanded ? "expanded" : ""}`} aria-expanded={expanded}
      onClick={() => setOpen(!expanded)} title={expanded ? "收起子智能体" : "展开子智能体"} aria-label={`${entry.children.length} 个子智能体`}>
      <ChevronRight size={12} aria-hidden="true" />
      {entry.children.length}
    </button>
  );
  return (
    <>
      {renderRow(entry.session, toggle || undefined)}
      {expanded && <div className="session-children">{entry.children.map((child) => renderRow(child))}</div>}
    </>
  );
}
