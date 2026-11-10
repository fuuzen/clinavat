import { useSyncExternalStore } from "react";

/** Injected by the Clinavat desktop and mobile client into every page it shows. */
export interface ClientShell {
  platform: string;
  version: string;
  /** Navigating here returns the client to its Hub list; the client intercepts it before any request. */
  switchHubUrl: string;
}

declare global {
  interface Window {
    __CLINAVAT_CLIENT__?: unknown;
  }
}

function readShell(): ClientShell | null {
  const shell = window.__CLINAVAT_CLIENT__ as Partial<ClientShell> | undefined;
  return shell && typeof shell.platform === "string" && typeof shell.version === "string"
    && typeof shell.switchHubUrl === "string" ? shell as ClientShell : null;
}

function subscribe(listener: () => void) {
  // Android may inject the client marker after the page scripts have started.
  window.addEventListener("clinavat:client", listener);
  return () => window.removeEventListener("clinavat:client", listener);
}

export function useClientShell() {
  return useSyncExternalStore(subscribe, readShell, () => null);
}
