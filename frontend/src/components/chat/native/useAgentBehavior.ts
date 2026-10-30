import { useEffect, useRef, useState } from "react";
import type { AgentBehavior, Session } from "../../../types";

export function useAgentBehavior(session: Session | undefined, projectId: string | undefined,
  engine: "claude" | "codex", active: boolean,
  onChange: (sessionId: string, value: AgentBehavior) => Promise<void>) {
  const [behavior, setBehavior] = useState<AgentBehavior>({ agentMode: session?.agent_mode || "normal", rolePreset: session?.role_preset || "default" });
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current++;
    setBehavior({ agentMode: session?.agent_mode || "normal", rolePreset: engine === "codex" ? session?.role_preset || "default" : "default" });
    setSaving(false);
  }, [session?.id, projectId, engine, session?.agent_mode, session?.role_preset]);

  async function changeBehavior(next: AgentBehavior) {
    if (active || saving) return false;
    const previous = behavior;
    const request = ++requestRef.current;
    setBehavior(next);
    if (!session) return true;
    setSaving(true);
    try { await onChange(session.id, next); return true; }
    catch { if (request === requestRef.current) setBehavior(previous); return false; }
    finally { if (request === requestRef.current) setSaving(false); }
  }
  return { behavior, behaviorSaving: saving, changeBehavior };
}
