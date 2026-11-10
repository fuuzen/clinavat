import { invoke } from "@tauri-apps/api/core";

/** Validates an address with the same rules the client applies when opening it. */
export function normalizeHubUrl(url: string) {
  return invoke<string>("normalize_hub_url", { url });
}

/** Navigates the window to the Hub; on success this page is replaced. */
export function openHub(url: string) {
  return invoke<string>("open_hub", { url });
}

/** Abandons a Hub that is still loading and reloads this list. */
export function closeHub() {
  return invoke<void>("close_hub");
}

export function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "操作失败，请重试";
}
