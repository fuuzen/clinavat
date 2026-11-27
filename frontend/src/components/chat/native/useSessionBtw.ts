import { useCallback, useEffect, useState } from "react";
import { api, errorText, post } from "../../../api";
import { applyBtwEvent, type BtwEventDetail, type BtwExchange } from "./btwTypes";

export interface SessionBtwControl {
  exchanges: BtwExchange[];
  loading: boolean;
  submitting: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  ask: (question: string, options?: { model?: string | null; reasoningEffort?: string | null; slotId?: string | null }) => Promise<boolean>;
  cancel: (btwId: string) => Promise<void>;
  remove: (btwId: string) => Promise<void>;
  clearFinished: () => Promise<void>;
}

export function useSessionBtw(
  sessionId: string | undefined,
  connected: boolean,
  onNotice: (message: string, kind?: "error" | "success") => void,
): SessionBtwControl {
  const [exchanges, setExchanges] = useState<BtwExchange[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async (targetId: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const items = await api<BtwExchange[]>(`/sessions/${targetId}/btw`, { signal });
      if (!signal?.aborted) setExchanges(Array.isArray(items) ? items : []);
    } catch (cause) {
      if (!signal?.aborted) onNotice(errorText(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    setExchanges([]);
    setCollapsed(false);
    if (!sessionId) return;
    const controller = new AbortController();
    void load(sessionId, controller.signal);
    return () => controller.abort();
  }, [sessionId, load]);

  useEffect(() => {
    if (!sessionId || !connected) return;
    const controller = new AbortController();
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<BtwEventDetail>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (detail.action === "upsert" && detail.exchange?.status === "running") {
        setCollapsed(false);
      }
      setExchanges((previous) => applyBtwEvent(previous, detail));
    };
    window.addEventListener("clinavat:btw", receive);
    // Resync after SSE reconnect so missed deltas/completions are caught up.
    void load(sessionId, controller.signal);
    return () => {
      controller.abort();
      window.removeEventListener("clinavat:btw", receive);
    };
  }, [sessionId, connected, load]);

  const ask = useCallback(async (
    question: string,
    options?: { model?: string | null; reasoningEffort?: string | null; slotId?: string | null },
  ): Promise<boolean> => {
    if (!sessionId) return false;
    const trimmed = question.trim();
    if (!trimmed) return false;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { question: trimmed };
      if (options?.slotId) body.slotId = options.slotId;
      if (options?.model !== undefined) body.model = options.model;
      if (options?.reasoningEffort !== undefined) body.reasoningEffort = options.reasoningEffort;
      const created = await post<BtwExchange>(`/sessions/${sessionId}/btw`, body);
      setCollapsed(false);
      setExchanges((previous) => applyBtwEvent(previous, { sessionId, action: "upsert", exchange: created }));
      return true;
    } catch (cause) {
      onNotice(errorText(cause));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, onNotice]);

  const cancel = useCallback(async (btwId: string) => {
    if (!sessionId) return;
    try {
      const updated = await post<BtwExchange>(`/sessions/${sessionId}/btw/${btwId}/cancel`, {});
      setExchanges((previous) => applyBtwEvent(previous, { sessionId, action: "upsert", exchange: updated }));
    } catch (cause) {
      onNotice(errorText(cause));
    }
  }, [sessionId, onNotice]);

  const remove = useCallback(async (btwId: string) => {
    if (!sessionId) return;
    try {
      await api(`/sessions/${sessionId}/btw/${btwId}`, { method: "DELETE" });
      setExchanges((previous) => applyBtwEvent(previous, { sessionId, action: "delete", id: btwId }));
    } catch (cause) {
      onNotice(errorText(cause));
    }
  }, [sessionId, onNotice]);

  const clearFinished = useCallback(async () => {
    if (!sessionId) return;
    const finished = exchanges.filter((item) => item.status !== "running");
    if (!finished.length) return;
    const results = await Promise.allSettled(
      finished.map((item) => api(`/sessions/${sessionId}/btw/${item.id}`, { method: "DELETE" })),
    );
    const removedIds = new Set(
      finished.filter((_, index) => results[index].status === "fulfilled").map((item) => item.id),
    );
    if (removedIds.size) {
      setExchanges((previous) => previous.filter((item) => !removedIds.has(item.id)));
    }
    const failed = results.find((result) => result.status === "rejected");
    if (failed && failed.status === "rejected") onNotice(errorText(failed.reason));
  }, [sessionId, exchanges, onNotice]);

  return { exchanges, loading, submitting, collapsed, setCollapsed, ask, cancel, remove, clearFinished };
}
