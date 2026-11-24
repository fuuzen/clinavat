import { useEffect, useRef, useState } from "react";
import type { AgentBehavior, OrchestrationMode, Session, SuperReadMode } from "../../../types";
import { engineProfiles, type AgentEngine } from "../../../engines";

function orchestrationModeOf(session: Session | undefined, engine: AgentEngine): OrchestrationMode {
  if (!engineProfiles[engine].orchestration || session?.parent_session_id) return "off";
  if (session?.orchestration_mode === "super" || session?.orchestration_mode === "hybrid" || session?.orchestration_mode === "off") {
    return session.orchestration_mode;
  }
  return session?.orchestration === 1 ? "hybrid" : "off";
}

function superReadModeOf(session: Session | undefined): SuperReadMode {
  const mode = session?.super_read_mode;
  return mode === "off" || mode === "full" ? mode : "overview";
}

export function useAgentBehavior(session: Session | undefined, projectId: string | undefined,
  engine: AgentEngine, active: boolean,
  onChange: (sessionId: string, value: AgentBehavior) => Promise<void>) {
  const initialMode = orchestrationModeOf(session, engine);
  const [behavior, setBehavior] = useState<AgentBehavior>({
    agentMode: session?.agent_mode || "normal",
    rolePreset: session?.role_preset || "default",
    orchestration: initialMode !== "off",
    orchestrationMode: initialMode,
    superReadMode: superReadModeOf(session),
  });
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current++;
    const mode = orchestrationModeOf(session, engine);
    setBehavior({
      agentMode: session?.agent_mode || "normal",
      rolePreset: engineProfiles[engine].rolePresets ? session?.role_preset || "default" : "default",
      orchestration: mode !== "off",
      orchestrationMode: mode,
      superReadMode: superReadModeOf(session),
    });
    setSaving(false);
  }, [session?.id, projectId, engine, session?.agent_mode, session?.role_preset, session?.orchestration, session?.orchestration_mode, session?.super_read_mode, session?.parent_session_id]);

  async function changeBehavior(next: AgentBehavior) {
    if (active || saving) return false;
    const normalized: AgentBehavior = { ...next, orchestration: next.orchestrationMode !== "off" };
    const previous = behavior;
    const request = ++requestRef.current;
    setBehavior(normalized);
    if (!session) return true;
    setSaving(true);
    try { await onChange(session.id, normalized); return true; }
    catch { if (request === requestRef.current) setBehavior(previous); return false; }
    finally { if (request === requestRef.current) setSaving(false); }
  }
  return { behavior, behaviorSaving: saving, changeBehavior };
}
