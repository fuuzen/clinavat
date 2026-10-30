import { useCallback, type Dispatch, type SetStateAction } from "react";
import { api, errorText } from "./api";
import type { AgentBehavior, Overview, PermissionMode, Session } from "./types";

function useSessionUpdate(
  setOverview: Dispatch<SetStateAction<Overview | null>>,
  notify: (message: string) => void,
) {
  return useCallback(async (sessionId: string, values: { permissionMode?: PermissionMode; slotId?: string } & Partial<AgentBehavior>) => {
    try {
      const updated = await api<Session>(`/sessions/${sessionId}`, {
        method: "PATCH", body: JSON.stringify(values),
      });
      setOverview((previous) => previous ? {
        ...previous,
        sessions: previous.sessions.map((item) => item.id === updated.id ? updated : item),
      } : previous);
    } catch (cause) {
      notify(errorText(cause));
      throw cause;
    }
  }, [setOverview, notify]);
}

export function useSessionBehavior(
  setOverview: Dispatch<SetStateAction<Overview | null>>,
  notify: (message: string) => void,
) {
  const update = useSessionUpdate(setOverview, notify);
  return useCallback((sessionId: string, behavior: AgentBehavior) =>
    update(sessionId, behavior), [update]);
}

export function useSessionPermissions(
  setOverview: Dispatch<SetStateAction<Overview | null>>,
  notify: (message: string) => void,
) {
  const update = useSessionUpdate(setOverview, notify);
  return useCallback((sessionId: string, permissionMode: PermissionMode) =>
    update(sessionId, { permissionMode }), [update]);
}

export function useSessionSlot(
  setOverview: Dispatch<SetStateAction<Overview | null>>,
  notify: (message: string) => void,
) {
  const update = useSessionUpdate(setOverview, notify);
  return useCallback((sessionId: string, slotId: string) =>
    update(sessionId, { slotId }), [update]);
}
