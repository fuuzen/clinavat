import { useSyncExternalStore } from "react";
import { api } from "../api";
import { setSiteDefaultTheme } from "../theme";
import { defaultSiteSettings, withSiteDefaults, type SiteSettings } from "./settings";

const listeners = new Set<() => void>();
let settings = defaultSiteSettings;
let pending: Promise<SiteSettings> | undefined;
let revision = 0;
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("clinavat-site-settings") : undefined;
channel?.addEventListener("message", () => { void loadSiteSettings().catch(() => undefined); });

export function publishSiteSettings(next: SiteSettings, broadcast = true) {
  revision++;
  settings = withSiteDefaults(next);
  document.title = settings.name;
  document.querySelector('meta[name="description"]')?.setAttribute("content", settings.description);
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (favicon) {
    favicon.href = settings.favicon || settings.logo || `${import.meta.env.BASE_URL}favicon.svg`;
    favicon.removeAttribute("type");
  }
  setSiteDefaultTheme(settings.theme);
  listeners.forEach((listener) => listener());
  if (broadcast) channel?.postMessage("updated");
}

export function loadSiteSettings(): Promise<SiteSettings> {
  if (!pending) {
    const requestedRevision = revision;
    pending = api<SiteSettings>("/site/settings").then((next) => {
      if (revision === requestedRevision) publishSiteSettings(next, false);
      return settings;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSiteSettings() {
  return useSyncExternalStore(subscribe, () => settings);
}
