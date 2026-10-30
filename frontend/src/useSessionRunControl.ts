import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { errorText, isActive, post } from "./api";
import type { Overview, Session } from "./types";

type RunAction = "pause" | "resume" | "stop";
type RunStatus = "pausing" | "paused" | "running";

export function useSessionRunControl(
  session: Session | undefined,
  selectedSessionRef: RefObject<string>,
  setOverview: Dispatch<SetStateAction<Overview | null>>,
  refresh: () => Promise<void>,
  reloadMessages: (sessionId: string) => Promise<void>,
  notify: (message: string, kind?: "error" | "success") => void,
) {
  const requests = useRef(new Map<string, Set<RunAction>>());
  const [pending, setPending] = useState(new Map<string, Set<RunAction>>());
  const run = useCallback(async (action: RunAction): Promise<boolean> => {
    if (!session || selectedSessionRef.current !== session.id) return false;
    const current = requests.current.get(session.id) ?? new Set<RunAction>();
    if (current.has("stop") || (action !== "stop" && (current.has("pause") || current.has("resume")))) return false;
    if (!isActive(session.status)) {
      notify("当前没有正在执行的任务。");
      return false;
    }
    current.add(action);
    requests.current.set(session.id, current);
    setPending(new Map(requests.current));
    try {
      const result = await post<{ status: RunStatus }>(`/sessions/${session.id}/${action}`);
      if (action !== "stop") setOverview((previous) => previous ? {
        ...previous,
        sessions: previous.sessions.map((item) => item.id === session.id && isActive(item.status)
          ? { ...item, status: result.status } : item),
      } : previous);
      await Promise.all([refresh(), reloadMessages(session.id)]);
      return true;
    } catch (cause) {
      const label = action === "pause" ? "暂停" : action === "resume" ? "继续" : "停止";
      notify(`${session.title}：${label}失败，${errorText(cause)}`);
      return false;
    } finally {
      current.delete(action);
      if (!current.size) requests.current.delete(session.id);
      setPending(new Map(requests.current));
    }
  }, [session, selectedSessionRef, setOverview, refresh, reloadMessages, notify]);
  const current = pending.get(session?.id || "");
  return {
    controlPending: !!current?.has("pause") || !!current?.has("resume"),
    stopPending: !!current?.has("stop"),
    pause: () => run("pause"),
    resume: () => run("resume"),
    stop: () => run("stop"),
  };
}
