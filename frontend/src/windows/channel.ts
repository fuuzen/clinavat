import type { WindowSyncMessage, WindowSyncPayload } from "./types";

export const WINDOW_SYNC_CHANNEL_NAME = "clinavat-windows";

const windowSenderId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let sharedChannel: BroadcastChannel | null = null;
const subscribers = new Set<(message: WindowSyncMessage) => void>();

function isWindowSyncMessage(value: unknown): value is WindowSyncMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === "string" && typeof candidate.sender === "string";
}

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== "function") return null;
  if (!sharedChannel) {
    sharedChannel = new BroadcastChannel(WINDOW_SYNC_CHANNEL_NAME);
    sharedChannel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isWindowSyncMessage(event.data)) return;
      if (event.data.sender === windowSenderId) return;
      for (const listener of subscribers) {
        listener(event.data);
      }
    });
  }
  return sharedChannel;
}

export function getWindowSenderId(): string {
  return windowSenderId;
}

export function broadcastWindowEvent(payload: WindowSyncPayload): void {
  const channel = getChannel();
  if (!channel) return;
  const message: WindowSyncMessage = { ...payload, sender: windowSenderId };
  try {
    channel.postMessage(message);
  } catch {
    // Ignore closed channel or structured-clone failures so callers stay resilient.
  }
}

export function subscribeWindowEvents(
  listener: (message: WindowSyncMessage) => void,
): () => void {
  getChannel();
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}
