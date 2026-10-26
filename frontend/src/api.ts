export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
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
    if (response.status === 401 && !path.startsWith("/auth/")) {
      window.dispatchEvent(new Event("cc-pool:unauthorized"));
    }
    throw new ApiError(
      String(body?.message || body?.error || `请求失败 (${response.status})`),
      response.status,
    );
  }
  return body as T;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
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
    IDLE: "空闲",
    ASSIGNED: "已分配",
    DISABLED: "已停用",
    RATE_LIMITED: "已限流",
    RUNNING: "运行中",
    COMPLETED: "已完成",
    STOPPED: "已停止",
    pending: "等待审批",
    running: "运行中",
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
