import { useCallback, useEffect, useState } from "react";
import { api, errorText, post } from "../../api";
import type { SessionRuntime } from "../../types";

const idle: SessionRuntime = { resident: false, turnActive: false, queue: [], tasks: [] };

/** Follows the queue and background tasks of a conversation's resident CLI. */
export function useSessionRuntime(sessionId: string | undefined, connected: boolean, onNotice: (message: string) => void) {
  const [runtime, setRuntime] = useState<SessionRuntime>(idle);
  useEffect(() => {
    setRuntime(idle);
    if (!sessionId || !connected) return;
    let disposed = false;
    let live = false;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; runtime?: SessionRuntime }>).detail;
      if (detail.sessionId !== sessionId || !detail.runtime) return;
      live = true;
      setRuntime(detail.runtime);
    };
    window.addEventListener("clinavat:runtime", receive);
    void api<SessionRuntime>(`/sessions/${sessionId}/runtime`).then((value) => {
      // A pushed update is newer than the snapshot requested before it.
      if (!disposed && !live) setRuntime(value);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener("clinavat:runtime", receive);
    };
  }, [sessionId, connected]);
  const cancelQueued = useCallback(async (id: string) => {
    if (!sessionId) return;
    try { await api(`/sessions/${sessionId}/queue/${id}`, { method: "DELETE" }); }
    catch (cause) { onNotice(errorText(cause)); }
  }, [sessionId, onNotice]);
  const stopTask = useCallback(async (id: string) => {
    if (!sessionId) return;
    try { await post(`/sessions/${sessionId}/tasks/${encodeURIComponent(id)}/stop`); }
    catch (cause) { onNotice(errorText(cause)); }
  }, [sessionId, onNotice]);
  return { runtime, cancelQueued, stopTask };
}
