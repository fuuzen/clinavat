import type {
  ArchivedSessionKind,
  ArchivedSessionsResponse,
  Session,
  TaskBoardArchiveResponse,
  TaskBoardResponse,
} from "./types";

let maintenanceEnabled = false;
const maintenanceListeners = new Set<(enabled: boolean) => void>();

function syncMaintenanceMode(next: boolean) {
  if (next === maintenanceEnabled) return;
  maintenanceEnabled = next;
  for (const listener of maintenanceListeners) listener(next);
}

if (typeof window !== "undefined") {
  window.addEventListener("clinavat:maintenance", (event: Event) => {
    const detail = (event as CustomEvent<{ enabled?: unknown }>).detail;
    if (detail && typeof detail.enabled === "boolean") syncMaintenanceMode(detail.enabled);
  });
}

export function isMaintenanceMode(): boolean {
  return maintenanceEnabled;
}

export function onMaintenanceChange(listener: (enabled: boolean) => void): () => void {
  maintenanceListeners.add(listener);
  return () => {
    maintenanceListeners.delete(listener);
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/") && path.split("?")[0] !== "/site/settings") {
      window.dispatchEvent(new Event("clinavat:unauthorized"));
    }
    throw new ApiError(
      String(body?.message || body?.error || `请求失败 (${response.status})`),
      response.status,
      body,
    );
  }
  if (body && typeof body === "object" && "maintenance" in body) {
    const state = body.maintenance as { enabled?: unknown } | null | undefined;
    if (state && typeof state.enabled === "boolean") syncMaintenanceMode(state.enabled);
  }
  return body as T;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function fetchSessionTasks(sessionId: string, includeArchived = false): Promise<TaskBoardResponse> {
  const suffix = includeArchived ? "?includeArchived=1" : "";
  return api<TaskBoardResponse>(`/sessions/${sessionId}/tasks${suffix}`);
}

export function archiveSessionTasks(sessionId: string, codes?: string[]): Promise<TaskBoardArchiveResponse> {
  return post<TaskBoardArchiveResponse>(`/sessions/${sessionId}/tasks/archive`, codes?.length ? { codes } : {});
}

export interface ArchivedSessionsQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  projectId?: string;
  kind?: ArchivedSessionKind;
}

export function fetchArchivedSessions(
  params: ArchivedSessionsQuery = {},
  signal?: AbortSignal,
): Promise<ArchivedSessionsResponse> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.pageSize !== undefined) query.set("pageSize", String(params.pageSize));
  if (params.q) query.set("q", params.q);
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.kind) query.set("kind", params.kind);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return api<ArchivedSessionsResponse>(`/sessions/archived${suffix}`, { signal });
}

export function fetchSessionById(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ session: Session }> {
  return api<{ session: Session }>(`/sessions/${sessionId}`, { signal });
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

export function statusLabel(status: string): string {
  const values: Record<string, string> = {
    CONNECTED: "已连接",
    DISCONNECTED: "未连接",
    ERROR: "连接异常",
    WATCHING: "同步中",
    SYNCING: "正在同步",
    PAUSED: "已暂停",
    READY: "已同步",
    DIRECT: "本机直执",
    LOCAL: "本机直连",
    OFFLINE: "已离线",
    IDLE: "空闲",
    DISABLED: "已停用",
    RATE_LIMITED: "已限流",
    RUNNING: "运行中",
    COMPLETED: "已完成",
    STOPPED: "已停止",
    pending: "等待审批",
    running: "运行中",
    pausing: "正在暂停",
    paused: "已暂停",
    idle: "就绪",
    error: "运行异常",
    waiting: "等待审批",
    completed: "已完成",
    interrupted: "已停止",
    CREATING: "正在初始化",
  };
  return values[status] || status;
}

export function isActive(status?: string): boolean {
  return [
    "RUNNING",
    "running",
    "pausing",
    "paused",
    "waiting",
    "streaming",
    "WAITING_APPROVAL",
  ].includes(status || "");
}

export function formatTime(timestamp: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(timestamp)
    ? timestamp.replace(" ", "T") + "Z"
    : timestamp;
  return new Date(normalized).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
