import { ApprovalCard } from "../../ToolCards";
import QuestionPanel from "../native/QuestionPanel";
import type { Approval, Session } from "../../../types";

/**
 * Unified Action Inbox inside a conversation: renders both the conversation's own pending approvals/questions
 * and those bubbled up from its active child agents so the user never has to leave the Super Agent view.
 */
export default function ActionInbox({
  session,
  sessions,
  approvals,
  connected,
  onApproval,
  onOpenSession,
}: {
  session?: Session;
  sessions: Session[];
  approvals: Approval[];
  connected: boolean;
  onApproval: (id: string, decision: "allow" | "deny", reason?: string) => Promise<void>;
  onOpenSession: (session: Session | string) => void;
}) {
  const childMap = new Map(
    session
      ? sessions
          .filter((item) => item.parent_session_id === session.id && !item.archived_at)
          .map((item) => [item.id, item] as const)
      : [],
  );
  const visibleApprovals = approvals.filter(
    (approval) =>
      (approval.session_id === session?.id || childMap.has(approval.session_id)) &&
      ["pending", "PENDING"].includes(approval.status),
  );
  return (
    <>
      {visibleApprovals.map((approval) => {
        const child = childMap.get(approval.session_id);
        return (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            childAgent={child ? { name: child.agent_name || child.title, onOpen: () => onOpenSession(child) } : undefined}
            onApproval={onApproval}
          />
        );
      })}
      <QuestionPanel
        sessionId={session?.id}
        connected={connected}
        onOpenSession={(targetId) => {
          onOpenSession(sessions.find((item) => item.id === targetId) ?? targetId);
        }}
      />
    </>
  );
}
