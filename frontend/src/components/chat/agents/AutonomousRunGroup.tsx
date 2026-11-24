import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, CircleHelp, ChevronDown, Flag, Workflow } from "lucide-react";
import { formatTime } from "../../../api";
import { noticeLabels, type CycleNotice, type RunCycle } from "./autonomousRuns";

const shownAgents = 4;
const noticeIcons = { decision: CircleHelp, escalation: AlertTriangle, milestone: Flag };

/** Marks a report cycle the user should look at, such as a decision to make or a failure to handle. */
export function CycleNoticeFrame({ notice, children }: { notice: CycleNotice; children: ReactNode }) {
  const Icon = noticeIcons[notice];
  return (
    <div className={`cycle-notice cycle-notice-${notice}`}>
      <span className="cycle-notice-badge"><Icon size={12} aria-hidden="true" />{noticeLabels[notice]}</span>
      {children}
    </div>
  );
}

/** Consecutive cycles in which the master kept its children working without asking the user anything. */
export default function AutonomousRunGroup({ cycles, children }: { cycles: RunCycle[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const agents = [...new Set(cycles.flatMap((cycle) => cycle.agents))];
  const toolCalls = cycles.reduce((total, cycle) => total + cycle.toolCalls, 0);
  const first = formatTime(cycles[0].messages[0].created_at);
  const last = formatTime(cycles[cycles.length - 1].messages[1].created_at);
  return (
    <section className="autonomous-run">
      <button type="button" className="autonomous-run-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
        <Workflow size={13} aria-hidden="true" />
        <strong>后台自治推进 · {cycles.length} 轮调度</strong>
        {agents.length > 0 && (
          <span className="autonomous-run-agents">
            {agents.slice(0, shownAgents).map((name) => <span key={name} className="autonomous-run-agent">{name}</span>)}
            {agents.length > shownAgents && <span className="autonomous-run-agent">+{agents.length - shownAgents}</span>}
          </span>
        )}
        <span className="autonomous-run-meta">{toolCalls} 次工具调用 · {first === last ? first : `${first} – ${last}`}</span>
        <span className="autonomous-run-action">{open ? "收起明细" : "展开明细"}<ChevronDown size={13} className={open ? "rotate" : ""} aria-hidden="true" /></span>
      </button>
      {open && <div className="autonomous-run-details" id={detailsId}>{children}</div>}
    </section>
  );
}
