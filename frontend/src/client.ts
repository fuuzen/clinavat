import { useSyncExternalStore } from "react";

/** Injected by the Clinavat desktop and mobile client into every page it shows. */
export interface ClientShell {
  platform: string;
  version: string;
  /** Navigating here returns the client to its Hub list; omitted in detached child windows. */
  switchHubUrl?: string;
  /** True on desktop clients that support native multi-window previews, settings, and memory windows. */
  multiWindow?: boolean;
  /** Navigating here closes the current detached child window; intercepted before any network request. */
  closeWindowUrl?: string;
  /** Navigating here unminimizes and focuses the main workbench window; intercepted before any network request. */
  focusMainUrl?: string;
  deviceId?: string;
  publicKey?: string;
  deviceName?: string;
  arch?: string;
  osVersion?: string;
  defaultShell?: string;
  homedir?: string;
}

export interface ClientDeviceShell extends ClientShell {
  deviceId: string;
  publicKey: string;
}

export function hasClientDeviceIdentity(shell: ClientShell | null): shell is ClientDeviceShell {
  return Boolean(
    shell &&
    typeof shell.deviceId === "string" &&
    shell.deviceId.trim() &&
    typeof shell.publicKey === "string" &&
    shell.publicKey.trim(),
  );
}

export function hasMultiWindowSupport(shell: ClientShell | null): boolean {
  return Boolean(shell && shell.multiWindow === true);
}

declare global {
  interface Window {
    __CLINAVAT_CLIENT__?: unknown;
  }
}

export function readClientShell(): ClientShell | null {
  if (typeof window === "undefined") return null;
  const shell = window.__CLINAVAT_CLIENT__ as Partial<ClientShell> | undefined;
  if (!shell || typeof shell.platform !== "string" || typeof shell.version !== "string") {
    return null;
  }
  if (typeof shell.switchHubUrl !== "string" && shell.multiWindow !== true) {
    return null;
  }
  return shell as ClientShell;
}

function subscribe(listener: () => void) {
  // Android may inject the client marker after the page scripts have started.
  window.addEventListener("clinavat:client", listener);
  return () => window.removeEventListener("clinavat:client", listener);
}

export function useClientShell() {
  return useSyncExternalStore(subscribe, readClientShell, () => null);
}
