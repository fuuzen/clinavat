import { hasMultiWindowSupport, readClientShell, type ClientShell } from "../client";
import { broadcastWindowEvent, subscribeWindowEvents } from "./channel";
import {
  buildDetachedWindowUrl,
  detachedWindowKey,
  isValidSettingsTab,
  windowNameForTarget,
  type DetachedWindowTarget,
} from "./types";

export interface LaunchOptions {
  shell?: ClientShell | null;
  openFn?: (url: string, target: string, features?: string) => Window | null;
  baseHref?: string;
  onFallback?: () => void;
  /** Safety timeout when `window.open` returns `null` and no native ack/deny arrives (normally arrives in <5ms). */
  ackTimeoutMs?: number;
}

const DEFAULT_ACK_TIMEOUT_MS = 2800;

export function canUseMultiWindow(shell: ClientShell | null = readClientShell()): boolean {
  return hasMultiWindowSupport(shell);
}

/**
 * Opens a detached native desktop window when the client supports `multiWindow`.
 * - Browser, mobile, and legacy desktop clients immediately invoke `onFallback` and return `false`.
 * - Registers the native ack/deny listeners before invoking `window.open` so neither synchronous nor
 *   fast pre-build native acknowledgments can be missed; falls back to the in-page modal on `ok: false`
 *   or if unacknowledged before `ackTimeoutMs`.
 */
export function openDetachedWindow(
  target: DetachedWindowTarget,
  options: LaunchOptions = {},
): boolean {
  const shell = options.shell !== undefined ? options.shell : readClientShell();
  if (!canUseMultiWindow(shell)) {
    options.onFallback?.();
    return false;
  }

  const opener =
    options.openFn ??
    (typeof window !== "undefined" && typeof window.open === "function"
      ? (url: string, name: string, features?: string) => window.open(url, name, features)
      : null);

  if (!opener) {
    options.onFallback?.();
    return false;
  }

  const url = buildDetachedWindowUrl(target, options.baseHref);
  const windowName = windowNameForTarget(target);
  const key = detachedWindowKey(target);

  // If the settings window is already open, switch its active tab smoothly without forcing a reload.
  if (target.kind === "settings" && target.tab && isValidSettingsTab(target.tab)) {
    broadcastWindowEvent({ type: "settings-tab", tab: target.tab });
  }

  const fallback = options.onFallback;
  const canListen = Boolean(fallback && typeof window !== "undefined");
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeChannel: (() => void) | undefined;

  const cleanup = () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("clinavat:window-ack", onAck);
      window.removeEventListener("clinavat:window-denied", onDenied);
    }
    unsubscribeChannel?.();
    unsubscribeChannel = undefined;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const confirm = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };

  const deny = () => {
    if (settled) return;
    settled = true;
    cleanup();
    fallback?.();
  };

  const onAck = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: unknown; ok?: unknown }>).detail;
    if (detail?.key !== key) return;
    if (detail.ok === false) deny();
    else confirm();
  };

  const onDenied = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: unknown }>).detail;
    if (detail?.key === key) deny();
  };

  if (canListen) {
    unsubscribeChannel = subscribeWindowEvents((message) => {
      if (message.type === "window-ready" && message.key === key) {
        confirm();
      }
    });
    window.addEventListener("clinavat:window-ack", onAck);
    window.addEventListener("clinavat:window-denied", onDenied);
  }

  let opened: Window | null = null;
  try {
    opened = opener(url, windowName, "noopener");
  } catch {
    deny();
    return false;
  }

  if (opened) {
    confirm();
    return true;
  }

  // Synchronous callers without an async fallback callback treat `null` as unavailable.
  if (!canListen) {
    return false;
  }

  if (!settled) {
    const timeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    timer = setTimeout(deny, timeoutMs);
  }
  return true;
}

export function closeCurrentWindow(shell: ClientShell | null = readClientShell()): boolean {
  if (typeof window === "undefined") return false;
  if (shell?.closeWindowUrl) {
    window.location.assign(shell.closeWindowUrl);
    return true;
  }
  window.close();
  return false;
}

export function focusMainWindow(shell: ClientShell | null = readClientShell()): boolean {
  if (typeof window === "undefined") return false;
  if (shell?.focusMainUrl) {
    window.location.assign(shell.focusMainUrl);
    return true;
  }
  window.opener?.focus?.();
  return false;
}
