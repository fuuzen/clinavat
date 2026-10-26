import { useState } from "react";
import { Check, ChevronDown, ShieldCheck, Terminal, X } from "lucide-react";
import type { Approval, ToolEvent } from "../types";
import ApprovalPreview from "./ApprovalPreview";
type ApprovalHandler = (
  id: string,
  decision: "allow" | "deny",
  reason?: string,
) => Promise<void>;

export function ToolCard({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-card">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Terminal size={14} />
        <strong>{tool.name}</strong>
        <span>{tool.status || "工具调用"}</span>
        <ChevronDown size={14} className={open ? "rotate" : ""} />
      </button>
      {open && (
        <div className="tool-details">
          {tool.input !== undefined && (
            <pre>
              {typeof tool.input === "string"
                ? tool.input
                : JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
          {tool.output && <pre className="tool-output">{tool.output}</pre>}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({
  approval,
  onApproval,
}: {
  approval: Approval;
  onApproval: ApprovalHandler;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    try {
      await onApproval(approval.id, decision, reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="approval-card">
      <div className="approval-heading">
        <span>
          <ShieldCheck size={17} />
          需要你的批准
        </span>
        <span className="badge badge-amber">等待中</span>
      </div>
      <p>
        智能体请求执行 <strong>{approval.tool}</strong>
      </p>
      <ApprovalPreview tool={approval.tool} input={approval.input} />
      <input
        aria-label="审批反馈"
        placeholder="补充反馈（可选）"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="approval-actions">
        <button
          className="button button-ghost"
          disabled={busy}
          onClick={() => void decide("deny")}
        >
          <X size={14} />
          拒绝
        </button>
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => void decide("allow")}
        >
          <Check size={14} />
          允许本次执行
        </button>
      </div>
    </div>
  );
}
