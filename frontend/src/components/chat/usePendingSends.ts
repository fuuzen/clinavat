import { useCallback, useRef, useState } from "react";

const requestKey = (projectId: string, sessionId: string) =>
  sessionId ? `session:${sessionId}` : `draft:${projectId}`;

export function usePendingSends(projectId: string, sessionId: string) {
  const requests = useRef(new Map<string, symbol>());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const publish = useCallback(() => setPending(new Set(requests.current.keys())), []);
  const clear = useCallback(() => {
    requests.current.clear();
    publish();
  }, [publish]);
  const begin = useCallback((targetProjectId: string, targetSessionId: string) => {
    let key = requestKey(targetProjectId, targetSessionId);
    if (requests.current.has(key)) return;
    const token = Symbol();
    requests.current.set(key, token);
    publish();
    return {
      useSession(id: string) {
        if (requests.current.get(key) !== token) return;
        requests.current.delete(key);
        key = requestKey(targetProjectId, id);
        requests.current.set(key, token);
        publish();
      },
      finish() {
        if (requests.current.get(key) !== token) return;
        requests.current.delete(key);
        publish();
      },
    };
  }, [publish]);
  return { sending: pending.has(requestKey(projectId, sessionId)), beginSend: begin, clearPendingSends: clear };
}
