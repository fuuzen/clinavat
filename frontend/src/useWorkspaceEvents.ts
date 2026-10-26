import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { errorText } from "./api";
import type { PoolEvent, ToolEvent, Turn } from "./types";
interface EventOptions {
  userId?: string;
  selectedSessionRef: RefObject<string>;
  refresh: () => Promise<void>;
  refreshApprovals: () => Promise<void>;
  reloadMessages: (id: string) => Promise<void>;
  receiveTurn: (turn: Turn) => void;
  notify: (message: string) => void;
  setStreamConnected: Dispatch<SetStateAction<boolean>>;
  setStreaming: Dispatch<SetStateAction<string>>;
  setTools: Dispatch<SetStateAction<ToolEvent[]>>;
  setSending: Dispatch<SetStateAction<boolean>>;
  setInspectorRefresh: Dispatch<SetStateAction<number>>;
}
export function useWorkspaceEvents({
  userId,
  selectedSessionRef,
  refresh,
  refreshApprovals,
  reloadMessages,
  receiveTurn,
  notify,
  setStreamConnected,
  setStreaming,
  setTools,
  setSending,
  setInspectorRefresh,
}: EventOptions) {
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!userId) return;
    void refreshApprovals();
    const source = new EventSource("/api/events", { withCredentials: true });
    source.onopen = () => {
      setStreamConnected(true);
      void refresh().catch(() => {});
      void refreshApprovals();
      if (selectedSessionRef.current)
        void reloadMessages(selectedSessionRef.current).catch(() => {});
    };
    source.onerror = () => {
      setStreamConnected(false);
      void refresh().catch(() => {});
    };
    function scheduleRefresh() {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = undefined;
        void refresh().catch((cause) => notify(errorText(cause)));
      }, 300);
    }
    source.onmessage = (event) => {
      let data: PoolEvent;
      try {
        data = JSON.parse(event.data) as PoolEvent;
      } catch {
        return;
      }
      const payload = data.payload;
      const object = payload && typeof payload === "object" ? payload : {};
      const current = data.sessionId === selectedSessionRef.current;
      if (
        data.type === "turn" &&
        current &&
        typeof object.id === "string" &&
        Array.isArray(object.items) &&
        object.session_id === data.sessionId
      ) {
        receiveTurn(object as unknown as Turn);
        setStreaming("");
        setTools([]);
      }
      if (data.type === "delta" && current) {
        const value =
          typeof payload === "string"
            ? payload
            : (object.text ?? object.delta ?? object.content);
        if (typeof value === "string")
          setStreaming((previous) => previous + value);
      }
      if (data.type === "tool" && current) {
        setTools((previous) => {
          const id = String(object.id || `tool-${Date.now()}`);
          const existing = previous.find((item) => item.id === id);
          const update =
            typeof object.output === "string" ? object.output : undefined;
          const output =
            object.append === true && update !== undefined
              ? (existing?.output || "") + update
              : (update ?? existing?.output);
          const tool: ToolEvent = {
            id,
            name: String(
              object.name || object.tool || existing?.name || "工具调用",
            ),
            input: object.input ?? existing?.input,
            output:
              output && output.length > 128 * 1024
                ? "[此前输出已截断]\n" + output.slice(-128 * 1024)
                : output,
            status:
              typeof object.status === "string"
                ? object.status
                : existing?.status,
          };
          return existing
            ? previous.map((item) => (item.id === id ? tool : item))
            : [...previous, tool];
        });
      }
      if (data.type === "message" && current) {
        setStreaming("");
        if (object.role === "user") setTools([]);
        void reloadMessages(selectedSessionRef.current).catch((cause) =>
          notify(errorText(cause)),
        );
      }
      if (data.type === "approval") void refreshApprovals();
      if (
        data.type === "session" ||
        data.type === "project" ||
        data.type === "done" ||
        data.type === "error"
      )
        scheduleRefresh();
      if (data.type === "project" || data.type === "done")
        setInspectorRefresh((value) => value + 1);
      if (data.type === "done" && current) {
        setSending(false);
        setStreaming("");
        void reloadMessages(selectedSessionRef.current).catch((cause) =>
          notify(errorText(cause)),
        );
        void refreshApprovals();
      }
      if (data.type === "error" && (!data.sessionId || current)) {
        setSending(false);
        setStreaming("");
        notify(
          typeof payload === "string"
            ? payload
            : String(object.message || object.error || "任务执行失败"),
        );
        if (current)
          void reloadMessages(selectedSessionRef.current).catch(() => {});
      }
    };
    return () => {
      source.close();
      setStreamConnected(false);
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = undefined;
      }
    };
  }, [userId, refresh, refreshApprovals, reloadMessages, receiveTurn, notify]);
}
