import { useEffect, useId, useState } from "react";
import { ChevronDown, Clock3, LoaderCircle } from "lucide-react";
import type { ActivityItem, ToolEvent, Turn } from "../../types";
import ExecutionGroup from "./ExecutionGroup";
import { Markdown } from "./MessageView";

function durationLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function activityGroups(items: ActivityItem[]) {
  const groups: (ActivityItem | ToolEvent[])[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || !item.tool) {
      groups.push(item);
      continue;
    }
    const previous = groups[groups.length - 1];
    if (Array.isArray(previous)) previous.push(item.tool);
    else groups.push([item.tool]);
  }
  return groups;
}

export default function TurnProcess({ turn }: { turn: Turn }) {
  const running = turn.status === "running";
  const [open, setOpen] = useState(running);
  const [now, setNow] = useState(Date.now());
  const detailsId = useId();
  useEffect(() => {
    setOpen(running);
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = turn.duration_ms ?? (
    (turn.completed_at ? Date.parse(turn.completed_at) : now) - Date.parse(turn.started_at)
  );
  const items = turn.items.filter((item) => running || !item.final);
  const status = turn.status === "interrupted" ? " · 已停止" : turn.status === "error" ? " · 出错" : "";
  return (
    <section className={`turn-process ${running ? "turn-running" : "turn-finished"}`}>
      <button
        type="button"
        className="activity-toggle turn-toggle"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
      >
        {running ? <LoaderCircle size={13} className="spin" /> : <Clock3 size={13} />}
        <span>{running ? "Working for" : "Worked for"} {durationLabel(Number.isFinite(elapsed) ? elapsed : 0)}{status}</span>
        <ChevronDown size={13} className={open ? "rotate" : ""} />
      </button>
      {open && (
        <div className="turn-details" id={detailsId}>
          {activityGroups(items).map((group) => Array.isArray(group) ? (
            <ExecutionGroup key={group[0].id} tools={group} />
          ) : (
            <div key={group.id} className={`activity-text activity-${group.kind}`}>
              {group.kind === "reasoning" && <span className="reasoning-label">思考摘要</span>}
              {group.text && <Markdown text={group.text} />}
            </div>
          ))}
          {items.length === 0 && <p className="activity-placeholder">{running ? "智能体正在处理任务…" : "本轮没有额外的执行记录。"}</p>}
        </div>
      )}
    </section>
  );
}
