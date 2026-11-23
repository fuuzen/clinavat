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
    /** Merges a child's branch; on conflict the project stays as it was unless `leave` keeps the markers for the user. */
    merge: (childId: string, onConflict: "abort" | "leave") => act(async () => {
      const outcome = await post<{ status: string; detail: string; files: string[] }>(`/sessions/${sessionId}/agents/${childId}/merge`, { onConflict });
      if (outcome.status !== "merged") onNotice(`${outcome.detail}${outcome.files.length ? `（${outcome.files.join("、")}）` : ""}`);
    }),
    discard: (childId: string) => act(async () => setView(await post<AgentPanelView>(`/sessions/${sessionId}/agents/${childId}/discard`, {}))),
    handoff: (childId: string) => act(() => post(`/sessions/${sessionId}/agents/${childId}/handoff`, {})),
    archiveChild: (childId: string) => act(() => post(`/sessions/${childId}/archive`, {})),
    deleteMemory: (key: string) => act(async () => setView(await api<AgentPanelView>(
      `/sessions/${sessionId}/agents/memories/${encodeURIComponent(key)}`, { method: "DELETE" },
    ))),
    stopDiscussion: (discussionId: string) => act(() => post(`/discussions/${discussionId}/stop`, {})),
  };
}
