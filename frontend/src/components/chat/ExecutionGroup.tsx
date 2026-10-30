import { useId, useState } from "react";
import { ChevronDown, LoaderCircle, Terminal } from "lucide-react";
import type { ToolEvent } from "../../types";
import { ToolCard } from "../ToolCards";

function toolCategory(tool: ToolEvent) {
  const name = tool.name.toLowerCase();
  if (/command|bash|shell|exec/.test(name)) return "commands";
  if (/search|grep/.test(name)) return "searches";
  if (/read/.test(name)) return "reads";
  if (/list|glob/.test(name)) return "directories";
  if (/write|edit|replace|patch|diff/.test(name)) return "edits";
  return "tools";
}

function executionLabel(tools: ToolEvent[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const category = toolCategory(tool);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts].map(([category, count]) => {
    if (category === "commands") return `Ran ${count} command${count === 1 ? "" : "s"}`;
    if (category === "searches") return `Searched ${count} time${count === 1 ? "" : "s"}`;
    if (category === "reads") return `Read ${count} file${count === 1 ? "" : "s"}`;
    if (category === "directories") return `Explored ${count} director${count === 1 ? "y" : "ies"}`;
    if (category === "edits") return `Updated ${count} file${count === 1 ? "" : "s"}`;
    return `Used ${count} tool${count === 1 ? "" : "s"}`;
  }).join(" · ");
}

export default function ExecutionGroup({ tools, paused = false }: { tools: ToolEvent[]; paused?: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const running = !paused && tools.some((tool) => ["running", "waiting", "pending"].includes(tool.status || ""));
  return (
    <div className="execution-group">
      <button
        type="button"
        className="activity-toggle execution-toggle"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
      >
        {running ? <LoaderCircle size={13} className="spin" /> : <Terminal size={13} />}
        <span>{executionLabel(tools)}</span>
        <ChevronDown size={13} className={open ? "rotate" : ""} />
      </button>
      {open && <div id={detailsId} className="execution-details">
        {tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
      </div>}
    </div>
  );
}
