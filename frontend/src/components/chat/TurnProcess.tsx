import { useEffect, useId, useState } from "react";
import { ChevronDown, Clock3, CornerDownRight, LoaderCircle, Pause } from "lucide-react";
import { isActive } from "../../api";
import type { ActivityItem, ToolEvent, Turn } from "../../types";
import ExecutionGroup from "./ExecutionGroup";
import { Markdown } from "./MessageView";
import { displayableSegmentItems, type TurnSegment } from "./native/turnSegments";

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

export default function TurnProcess({ turn, segment }: { turn: Turn; segment?: TurnSegment }) {
  const steered = !!segment?.steered;
  const segmented = !!segment && segment.total > 1;
  const live = steered ? false : isActive(turn.status);
  const paused = !steered && turn.status === "paused";
  const running = !steered && (turn.status === "running" || turn.status === "pausing");
  const [open, setOpen] = useState(live);
  const [now, setNow] = useState(Date.now());
  const detailsId = useId();
  useEffect(() => {
    setOpen(live);
  }, [live]);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = segmented
    ? Math.max(0, (
      segment.endedAt ? Date.parse(segment.endedAt) : paused && turn.paused_at ? Date.parse(turn.paused_at) : now
    ) - Date.parse(segment.startedAt) - (segment.isLast ? (turn.paused_ms ?? 0) : 0))
    : (turn.duration_ms ?? (
      (turn.completed_at ? Date.parse(turn.completed_at) : paused && turn.paused_at ? Date.parse(turn.paused_at) : now)
        - Date.parse(turn.started_at) - (turn.paused_ms ?? 0)
    ));
  const items = displayableSegmentItems(segment ? segment.items : turn.items, live);
  const status = steered
    ? ""
    : paused ? " · 已暂停" : turn.status === "pausing" ? " · 正在暂停" : turn.status === "interrupted" ? " · 已停止" : turn.status === "error" ? " · 出错" : "";
  const stateClass = steered ? "turn-steered" : paused ? "turn-paused" : running ? "turn-running" : "turn-finished";
  return (
    <section className={`turn-process ${stateClass}`}>
      <button
        type="button"
        className="activity-toggle turn-toggle"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
      >
        {steered ? <CornerDownRight size={13} /> : paused ? <Pause size={13} /> : running ? <LoaderCircle size={13} className="spin" /> : <Clock3 size={13} />}
        <span>{live ? "Working for" : "Worked for"} {durationLabel(Number.isFinite(elapsed) ? elapsed : 0)}{status}</span>
        {steered && <span className="turn-steered-badge">已引导</span>}
        <ChevronDown size={13} className={open ? "rotate" : ""} />
      </button>
      {open && (
        <div className="turn-details" id={detailsId}>
          {activityGroups(items).map((group) => Array.isArray(group) ? (
            <ExecutionGroup key={group[0].id} tools={group} paused={paused} sealed={steered} />
          ) : (
            <div key={group.id} className={`activity-text activity-${group.kind}`}>
              {group.kind === "reasoning" && <span className="reasoning-label">思考摘要</span>}
              {group.kind === "notice" && <span className="reasoning-label">API 重试</span>}
              {group.text && <Markdown text={group.text} />}
            </div>
          ))}
          {items.length === 0 && <p className="activity-placeholder">{paused ? "任务已暂停，点击继续即可恢复。" : running ? "智能体正在处理任务…" : "本轮没有额外的执行记录。"}</p>}
        </div>
      )}
    </section>
  );
}
