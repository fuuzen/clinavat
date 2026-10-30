import { useEffect, useState, useSyncExternalStore } from "react";
import { api, post } from "./api";
import type { SlotUsage } from "./types";

// One store shared by every view, so open pages do not multiply backend queries.
let snapshot: Record<string, SlotUsage> = {};
const listeners = new Set<() => void>();
const POLL_INTERVAL = 90_000;
let activeConsumers = 0;
let pollTimer: number | undefined;
let pendingLoad: Promise<void> | undefined;
let loadController: AbortController | undefined;

function publish(next: Record<string, SlotUsage>) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function receiveSlotUsage(usage: SlotUsage) {
  publish({ ...snapshot, [usage.slotId]: usage });
}

function load() {
  if (pendingLoad) return pendingLoad;
  const controller = new AbortController();
  const before = snapshot;
  loadController = controller;
  const request = api<Record<string, SlotUsage>>("/slots/usage?refresh=1", { signal: controller.signal })
    .then((result) => {
      if (controller.signal.aborted) return;
      const next = { ...snapshot };
      for (const [slotId, usage] of Object.entries(result)) {
        // A live event received while this request was running is newer than its response.
        if (snapshot[slotId] === before[slotId]) next[slotId] = usage;
      }
      publish(next);
    })
    .catch(() => {
      if (controller.signal.aborted) return;
      const next = { ...snapshot };
      for (const [slotId, usage] of Object.entries(before)) {
        if (snapshot[slotId] === usage) next[slotId] = { ...usage, stale: true, error: "额度同步失败，待重试" };
      }
      publish(next);
    })
    .finally(() => {
      if (pendingLoad === request) {
        pendingLoad = undefined;
        loadController = undefined;
      }
    });
  pendingLoad = request;
  return request;
}

function pollWhenVisible() {
  if (document.visibilityState === "visible") void load();
}

function acquirePolling() {
  activeConsumers += 1;
  if (activeConsumers === 1) {
    pollWhenVisible();
    pollTimer = window.setInterval(pollWhenVisible, POLL_INTERVAL);
    document.addEventListener("visibilitychange", pollWhenVisible);
  }
  return () => {
    activeConsumers -= 1;
    if (activeConsumers > 0) return;
    window.clearInterval(pollTimer);
    pollTimer = undefined;
    document.removeEventListener("visibilitychange", pollWhenVisible);
    loadController?.abort();
    loadController = undefined;
    pendingLoad = undefined;
  };
}

export async function refreshSlotUsage(slotId: string) {
  receiveSlotUsage(await post<SlotUsage>(`/slots/${slotId}/usage/refresh`));
}

// While active, asks the backend to re-query entries older than its minimum interval.
export function useSlotUsage(active: boolean): Record<string, SlotUsage> {
  const usage = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    if (!active) return;
    return acquirePolling();
  }, [active]);
  return usage;
}

export function useNow(interval = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, interval);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [interval]);
  return now;
}
