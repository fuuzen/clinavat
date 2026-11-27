import { useEffect, useRef, useState } from "react";
import type { AgentBehavior, OrchestrationMode, PermissionMode, Session, SuperReadMode } from "../../../types";
import { engineProfiles, type AgentEngine } from "../../../engines";
import { defaultPermissionMode, defaultPermissionModeFor } from "../PermissionPicker";
import { isUnsafeClientPermission } from "../../hosts/client-device";

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

export function useChatPermissionMode(options: {
  session?: Session;
  projectId?: string;
  engine: AgentEngine;
  personalPermission?: PermissionMode | null;
  isClientProject: boolean;
  active: boolean;
  onPermissionChange: (sessionId: string, mode: PermissionMode) => Promise<void>;
}) {
  const { session, projectId, engine, personalPermission, isClientProject, active, onPermissionChange } = options;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(session?.permission_mode || defaultPermissionMode);
  const [pendingUnsafePermission, setPendingUnsafePermission] = useState<PermissionMode | null>(null);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const requestRef = useRef(0);

  // New conversations start with the user's default for its CLI, except unsandboxed client hosts never default to YOLO/full-access.
  useEffect(() => {
    requestRef.current += 1;
    setPendingUnsafePermission(null);
    const safePersonal = isClientProject && isUnsafeClientPermission(personalPermission) ? null : personalPermission;
    setPermissionMode(session?.permission_mode || safePersonal || defaultPermissionModeFor(engine));
    setPermissionSaving(false);
  }, [session?.id, projectId, session?.permission_mode, engine, personalPermission, isClientProject]);

  async function applyPermissionChange(mode: PermissionMode) {
    if (active || permissionSaving) return;
    const previous = permissionMode;
    const request = ++requestRef.current;
    setPermissionMode(mode);
    if (!session) return;
    setPermissionSaving(true);
    try {
      await onPermissionChange(session.id, mode);
    } catch {
      if (request === requestRef.current) setPermissionMode(previous);
    } finally {
      if (request === requestRef.current) setPermissionSaving(false);
    }
  }

  function requestPermissionChange(mode: PermissionMode) {
    if (active || permissionSaving || mode === permissionMode) return;
    if (isClientProject && isUnsafeClientPermission(mode)) {
      setPendingUnsafePermission(mode);
      return;
    }
    void applyPermissionChange(mode);
  }

  return {
    permissionMode,
    permissionSaving,
    pendingUnsafePermission,
    setPendingUnsafePermission,
    applyPermissionChange,
    requestPermissionChange,
  };
}
