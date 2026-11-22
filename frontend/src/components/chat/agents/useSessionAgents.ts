import { useCallback, useEffect, useState } from "react";
import { api, errorText, post } from "../../../api";
import type { AgentPanelView } from "../../../types";

/** Follows a master conversation's children and their reports for the agent panel. */
export function useSessionAgents(sessionId: string | undefined, enabled: boolean, onNotice: (message: string) => void) {
  const [view, setView] = useState<AgentPanelView | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setView(null);
    if (!sessionId || !enabled) return;
    let disposed = false;
    let live = false;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; agents?: AgentPanelView }>).detail;
      if (detail.sessionId !== sessionId || !detail.agents) return;
      live = true;
      setView(detail.agents);
    };
    window.addEventListener("clinavat:agents", receive);
    void api<AgentPanelView>(`/sessions/${sessionId}/agents`).then((value) => {
      if (!disposed && !live) setView(value);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener("clinavat:agents", receive);
    };
  }, [sessionId, enabled]);
  const act = useCallback(async (operation: () => Promise<unknown>) => {
    setPending(true);
    try { await operation(); }
    catch (cause) { onNotice(errorText(cause)); }
    finally { setPending(false); }
  }, [onNotice]);
  return {
    view, pending,
    stopAll: () => act(() => post(`/sessions/${sessionId}/agents/stop`, {})),
    stop: (childId: string) => act(() => post(`/sessions/${childId}/stop`)),
    deliver: () => act(async () => setView(await post<AgentPanelView>(`/sessions/${sessionId}/agents/deliver`, {}))),
  };
}
