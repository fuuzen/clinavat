import { invoke } from "@tauri-apps/api/core";

export type FingerprintReason = "untrusted_http" | "changed";

export interface PendingFingerprintInfo {
  hubKey: string;
  hubUrl: string;
  host: string;
  hostKeyFingerprint: string;
  expectedFingerprint?: string;
  reason: FingerprintReason;
}

export type HubDaemonState =
  | "stopped"
  | "bootstrapping"
  | "unregistered"
  | "suspended"
  | "maintenance"
  | "awaiting_fingerprint"
  | "error"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface HubDaemonStatus {
  hubUrl: string;
  hubKey: string;
  enabled: boolean;
  status: HubDaemonState;
  hostId?: string;
  hostName?: string;
  transport?: string;
  fingerprint?: string;
  lastError?: string;
  reconnectAttempt?: number;
  reconnectDelayMs?: number;
  pendingFingerprint?: PendingFingerprintInfo;
}

export interface DaemonBridgeSnapshot {
  supported: boolean;
  deviceId?: string;
  deviceName?: string;
  publicKey?: string;
  platform: string;
  arch?: string;
  defaultShell?: string;
  initError?: string;
  configError?: string;
  hubs: HubDaemonStatus[];
}

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

export function getDaemonStatus() {
  return invoke<DaemonBridgeSnapshot>("daemon_status");
}

export function setHubDaemonEnabled(hubUrl: string, enabled: boolean) {
  return invoke<DaemonBridgeSnapshot>("set_hub_daemon_enabled", { hubUrl, enabled });
}

export function reconnectHubDaemon(hubUrl: string) {
  return invoke<DaemonBridgeSnapshot>("reconnect_hub_daemon", { hubUrl });
}

export function disconnectHubDaemon(hubUrl: string) {
  return invoke<DaemonBridgeSnapshot>("disconnect_hub", { hubUrl });
}

export function disconnectAllDaemons() {
  return invoke<DaemonBridgeSnapshot>("disconnect_all");
}

export function syncKnownHubs(hubUrls: string[]) {
  return invoke<DaemonBridgeSnapshot>("sync_known_hubs", { hubUrls });
}

export function confirmHostFingerprint(hubUrl: string, fingerprint: string) {
  return invoke<DaemonBridgeSnapshot>("confirm_host_fingerprint", { hubUrl, fingerprint });
}

export function rejectHostFingerprint(hubUrl: string) {
  return invoke<DaemonBridgeSnapshot>("reject_host_fingerprint", { hubUrl });
}

export function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "操作失败，请重试";
}
