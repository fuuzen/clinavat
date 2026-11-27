import type { ClientPlatform, ClientProjectMode, DevHost, PermissionMode, Project } from "../../types";

export function isClientHost(host?: DevHost | null): host is DevHost & { kind: "client" } {
  return host?.kind === "client";
}

export function isClientHostOnline(host?: DevHost | null): boolean {
  if (!isClientHost(host)) return false;
  if (typeof host.device?.online === "boolean") return host.device.online;
  return host.status === "CONNECTED";
}

export function normalizeClientPlatform(platform?: string | null): ClientPlatform {
  const value = (platform || "").trim().toLowerCase();
  if (value === "win32" || value.startsWith("win")) return "windows";
  if (value === "darwin" || value.startsWith("mac")) return "macos";
  return "linux";
}

export function clientPlatformLabel(platform?: string | null): string {
  const value = (platform || "").trim().toLowerCase();
  if (!value) return "桌面客户端";
  if (value === "win32" || value.startsWith("win")) return "Windows";
  if (value === "darwin" || value.startsWith("mac")) return "macOS";
  if (value.startsWith("linux")) return "Linux";
  return platform || "桌面客户端";
}

export function isWindowsPlatform(platform?: string | null): boolean {
  const value = (platform || "").trim().toLowerCase();
  return value === "win32" || value.startsWith("win");
}

export function clientProjectModeOf(project?: Project | null, host?: DevHost | null): ClientProjectMode | null {
  if (!project) return null;
  if (project.client_mode === "direct" || project.client_mode === "mirrored") return project.client_mode;
  if (isClientHost(host)) return "direct";
  return null;
}

export function isClientDirectProject(project?: Project | null, host?: DevHost | null): boolean {
  return clientProjectModeOf(project, host) === "direct";
}

export function isClientMirroredProject(project?: Project | null, host?: DevHost | null): boolean {
  return clientProjectModeOf(project, host) === "mirrored";
}

export function isProjectWorkspaceReady(project?: Project | null, host?: DevHost | null): boolean {
  if (!project) return false;
  if (isClientHost(host)) {
    if (!isClientHostOnline(host)) return false;
    if (isClientDirectProject(project, host)) {
      return project.sync_status !== "ERROR" && project.sync_status !== "CREATING";
    }
    return project.sync_status === "WATCHING" || project.sync_status === "READY" || project.sync_status === "LOCAL";
  }
  return project.sync_status === "WATCHING" || project.sync_status === "LOCAL";
}

/** Both YOLO and CLI full-access skip confirmation prompts; never default to them on unsandboxed client hosts. */
export function isUnsafeClientPermission(mode?: PermissionMode | null): boolean {
  return mode === "yolo" || mode === "full-access";
}

export function formatClientLastSeen(timestamp?: string | null): string {
  if (!timestamp) return "尚未连接";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(timestamp)
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
