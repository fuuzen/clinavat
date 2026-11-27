import type { ThemePreferences } from "../theme";

export type DetachedWindowKind = "preview" | "settings" | "memory";

export const SETTINGS_TABS = [
  "account",
  "usage",
  "conversation",
  "roster",
  "archived",
  "appearance",
  "system",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export interface PreviewWindowTarget {
  kind: "preview";
  projectId: string;
  path: string;
  projectName?: string;
}

export interface SettingsWindowTarget {
  kind: "settings";
  tab?: SettingsTab;
}

export interface MemoryWindowTarget {
  kind: "memory";
  projectId: string;
  projectName?: string;
}

export type DetachedWindowTarget =
  | PreviewWindowTarget
  | SettingsWindowTarget
  | MemoryWindowTarget;

export type WindowSyncMessage =
  | { type: "theme-changed"; preferences: ThemePreferences; sender: string }
  | {
      type: "overview-changed";
      reason: "settings" | "account" | "archived" | "hosts" | "memory";
      projectId?: string;
      sender: string;
    }
  | { type: "file-saved"; projectId: string; path: string; etag?: string; sender: string }
  | { type: "memory-changed"; projectId: string; sender: string }
  | { type: "open-session"; sessionId: string; projectId?: string; sender: string }
  | { type: "locate-file"; projectId: string; path: string; sender: string }
  | { type: "settings-tab"; tab: SettingsTab; sender: string }
  | { type: "window-ready"; key: string; sender: string }
  | { type: "logout"; sender: string };

export type WindowSyncPayload =
  | { type: "theme-changed"; preferences: ThemePreferences }
  | {
      type: "overview-changed";
      reason: "settings" | "account" | "archived" | "hosts" | "memory";
      projectId?: string;
    }
  | { type: "file-saved"; projectId: string; path: string; etag?: string }
  | { type: "memory-changed"; projectId: string }
  | { type: "open-session"; sessionId: string; projectId?: string }
  | { type: "locate-file"; projectId: string; path: string }
  | { type: "settings-tab"; tab: SettingsTab }
  | { type: "window-ready"; key: string }
  | { type: "logout" };

const utf8Encoder = new TextEncoder();
// Matches Unicode C0 + C1 control characters (U+0000..=U+001F, U+007F..=U+009F), matching Rust `char::is_control()`.
const CONTROL_CHAR_RE = /\p{Cc}/u;

export const MAX_PROJECT_ID_BYTES = 128;
export const MAX_PROJECT_NAME_BYTES = 120;
export const MAX_PREVIEW_PATH_BYTES = 1024;

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

export function isValidSettingsTab(value: string | null | undefined): value is SettingsTab {
  if (typeof value !== "string") return false;
  return (SETTINGS_TABS as readonly string[]).includes(value.trim());
}

function cleanParam(value: string | null | undefined, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || utf8ByteLength(trimmed) > maxBytes || CONTROL_CHAR_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (utf8ByteLength(trimmed) <= maxBytes) return trimmed;
  let result = "";
  let bytes = 0;
  for (const ch of trimmed) {
    const size = utf8ByteLength(ch);
    if (bytes + size > maxBytes) break;
    result += ch;
    bytes += size;
  }
  return result.trim();
}

export function parseDetachedWindowFromSearch(search: string): DetachedWindowTarget | null {
  const params = new URLSearchParams(search);
  const kind = params.get("window");
  if (kind === "settings") {
    const rawTab = params.get("tab")?.trim() ?? "";
    if (!rawTab) return { kind: "settings" };
    return isValidSettingsTab(rawTab) ? { kind: "settings", tab: rawTab } : null;
  }
  if (kind === "memory") {
    const projectId = cleanParam(params.get("projectId"), MAX_PROJECT_ID_BYTES);
    if (!projectId) return null;
    const projectName = cleanParam(params.get("projectName"), MAX_PROJECT_NAME_BYTES) ?? undefined;
    return projectName ? { kind: "memory", projectId, projectName } : { kind: "memory", projectId };
  }
  if (kind === "preview") {
    const projectId = cleanParam(params.get("projectId"), MAX_PROJECT_ID_BYTES);
    const path = cleanParam(params.get("path"), MAX_PREVIEW_PATH_BYTES);
    if (!projectId || !path) return null;
    const projectName = cleanParam(params.get("projectName"), MAX_PROJECT_NAME_BYTES) ?? undefined;
    return projectName
      ? { kind: "preview", projectId, path, projectName }
      : { kind: "preview", projectId, path };
  }
  return null;
}

export function buildDetachedWindowUrl(
  target: DetachedWindowTarget,
  baseHref: string = typeof window !== "undefined" ? window.location.href : "http://localhost/",
): string {
  const url = new URL(baseHref);
  url.search = "";
  url.hash = "";
  url.searchParams.set("window", target.kind);
  if (target.kind === "settings") {
    const tab = target.tab?.trim();
    if (tab && isValidSettingsTab(tab)) {
      url.searchParams.set("tab", tab);
    }
  } else if (target.kind === "memory") {
    url.searchParams.set("projectId", target.projectId.trim());
    if (target.projectName) {
      const safeName = truncateUtf8(target.projectName, MAX_PROJECT_NAME_BYTES);
      if (safeName && !CONTROL_CHAR_RE.test(safeName)) {
        url.searchParams.set("projectName", safeName);
      }
    }
  } else {
    url.searchParams.set("projectId", target.projectId.trim());
    url.searchParams.set("path", target.path.trim());
    if (target.projectName) {
      const safeName = truncateUtf8(target.projectName, MAX_PROJECT_NAME_BYTES);
      if (safeName && !CONTROL_CHAR_RE.test(safeName)) {
        url.searchParams.set("projectName", safeName);
      }
    }
  }
  return url.toString();
}

/** Logical deduplication key normalized with `.trim()` to match the native Tauri window manager byte-for-byte. */
export function detachedWindowKey(target: DetachedWindowTarget): string {
  if (target.kind === "settings") return "settings";
  if (target.kind === "memory") return `memory:${target.projectId.trim()}`;
  return `preview:${target.projectId.trim()}:${target.path.trim()}`;
}

export function windowNameForTarget(target: DetachedWindowTarget): string {
  const key = detachedWindowKey(target);
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `clinavat_${target.kind}_${(hash >>> 0).toString(16)}`;
}
