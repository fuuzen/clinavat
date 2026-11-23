import { useState } from "react";
import { BookMarked, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { MemoryEntryView } from "../../../types";

/** Collapsible viewer for persistent project memory entries maintained by the Super Agent. */
export default function MemoryCard({
  memories,
  pending,
  onDelete,
}: {
  memories: MemoryEntryView[];
  pending: boolean;
  onDelete: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!memories.length) return null;
  return (
    <div className="agent-card memory-card" aria-label="持久记忆">
      <button type="button" className="task-board-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <BookMarked size={13} aria-hidden="true" />
        <strong className="task-board-title">持久记忆</strong>
        <span className="task-board-progress">{memories.map((item) => item.key).slice(0, 4).join(" · ")}{memories.length > 4 ? ` 等 ${memories.length} 条` : `（${memories.length}）`}</span>
      </button>
      {open && (
        <div className="memory-list">
          {memories.map((entry) => (
            <div key={entry.key} className="memory-entry">
              <div className="memory-entry-head">
                <code className="task-code">{entry.key}</code>
                <button type="button" className="agent-card-stop danger-text" disabled={pending}
                  onClick={() => onDelete(entry.key)} title={`删除记忆 ${entry.key}`} aria-label={`删除记忆 ${entry.key}`}>
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </div>
              <pre className="memory-entry-body">{entry.content}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
