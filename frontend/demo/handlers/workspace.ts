import { http, HttpResponse } from "msw";
import type { AgentModel, AgentPreference, DevHost, Project, SlotUsage } from "../../src/types";
import { completePaths, fileMeta, gitState, isDirectory, listFiles, readFile, remoteDirectories, writeFile } from "../filesystem";
import { emit } from "../events";
import { db, timestamp } from "../store";
import { tokenUsageReport } from "../token-usage";
import { fail, ok, readBody } from "./respond";

const transfers = new Map<string, Uint8Array[]>();
// Start times of simulated first syncs, which finish after firstSyncDuration.
const firstSyncs = new Map<string, number>();
const firstSyncDuration = 9000;
const firstSyncBytes = 48_600_000;
const syncRules = new Map<string, string>();
const demoDefaultIgnores = ["node_modules", "target", "dist", "build", ".venv", "__pycache__", "*.log", "*.zip", "/.bin", ".env", ".env.*"];

// Mirrors the Hub's conditional writes: If-None-Match: * creates only, If-Match replaces only an unchanged file.
function refusedWrite(request: Request, path: string) {
  if (isDirectory(path)) return fail(409, "同名目录已存在");
  const existing = fileMeta(path);
  if (existing && request.headers.get("if-none-match") === "*") return fail(412, "文件已存在");
  const expected = request.headers.get("if-match");
  if (expected && existing?.etag !== expected) return fail(412, existing ? "文件已在其他地方被修改" : "文件已被删除");
  return undefined;
}

const efforts = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const models: Record<string, AgentModel[]> = {
  claude: [
    { id: "claude-opus-5-5", name: "Opus 5.5", description: "复杂任务与长链路推理", reasoningEfforts: efforts, defaultReasoningEffort: "high", isDefault: true },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "日常编码的均衡选择", reasoningEfforts: efforts, defaultReasoningEffort: "medium" },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", description: "轻量快速", reasoningEfforts: [] },
  ],
  codex: [
    { id: "gpt-5-codex", name: "GPT-5 Codex", description: "面向编码优化", reasoningEfforts: efforts, defaultReasoningEffort: "medium", isDefault: true },
  ],
};

function usage(slotId: string): SlotUsage {
  const now = new Date().toISOString();
  const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const slot = db.slots.find((item) => item.id === slotId);
  if (slot?.auth_method === "token") {
    return { slotId, state: "unavailable", plan: null, credits: null, resetCredits: null, limited: null, observedAt: now, expiresAt: inHours(12), checkedAt: null,
      source: "query", stale: false, refreshing: false, windows: [], subscription: null,
      login: { method: "token", expiresAt: slot.token_expires_at ?? null, accessExpiresAt: null, refreshedAt: null },
      error: "长期令牌（setup-token）没有额度查询权限，额度只在对话运行时更新" };
  }
  return {
    slotId, state: "ok", plan: "Max", credits: null, limited: false,
    resetCredits: slot?.engine === "codex"
      ? { available: 1, credits: [{ id: "demo-reset", title: "额度重置", description: null, expiresAt: inHours(24 * 20) }] } : null, observedAt: now, expiresAt: inHours(12), checkedAt: now,
    source: "query", stale: false, refreshing: false, error: null,
    login: { method: "oauth", expiresAt: null, accessExpiresAt: inHours(5), refreshedAt: slot?.engine === "codex" ? inHours(-30) : null },
    subscription: slot?.engine === "codex"
      ? { plan: "pro", tier: null, startedAt: inHours(-24 * 340), expiresAt: inHours(24 * 25), verifiedAt: inHours(-30) }
      : { plan: "max", tier: "default_claude_max_20x", startedAt: inHours(-24 * 200), expiresAt: null, verifiedAt: null },
    windows: [
      { key: "five_hour", label: "5 小时", usedPercent: 37, resetsAt: inHours(3), windowMinutes: 300 },
      { key: "seven_day", label: "7 天", usedPercent: 62, resetsAt: inHours(80), windowMinutes: 10_080 },
      ...(slot?.engine === "claude"
        ? [{ key: "model:Fable", label: "每周 · Fable", usedPercent: 48, resetsAt: inHours(80), windowMinutes: 10_080 }] : []),
    ],
  };
}

function agentSettings() {
  const catalog = (engine: "claude" | "codex") => ({ models: models[engine],
    slots: db.slots.filter((slot) => slot.engine === engine)
      .map((slot) => ({ id: slot.id, label: slot.label, model_catalog_at: slot.model_catalog_at ?? timestamp(-60) })) });
  return { defaults: db.agentDefaults, catalogs: { claude: catalog("claude"), codex: catalog("codex") } };
}

function findProject(id: unknown): Project | undefined {
  return db.projects.find((project) => project.id === id);
}

export const workspaceHandlers = [
  http.get("/api/overview", () => db.signedIn
    ? HttpResponse.json({ user: db.user, slots: db.slots, hosts: db.hosts, projects: db.projects, sessions: db.sessions,
      questionDefaults: { mode: db.userQuestions.mode ?? db.siteQuestions.mode, timeoutMs: db.userQuestions.timeoutMs ?? db.siteQuestions.timeoutMs },
      agentDefaults: db.agentDefaults, deferredQuestions: [] })
    : fail(401, "请先登录")),
  http.get("/api/slots", () => HttpResponse.json(db.slots)),
  http.get("/api/slots/usage", () => HttpResponse.json(Object.fromEntries(db.slots.map((slot) => [slot.id, usage(slot.id)])))),
  http.post("/api/slots/:id/usage/refresh", ({ params }) => HttpResponse.json(usage(String(params.id)))),
  http.post("/api/slots/:id/limit-reset", ({ params }) => HttpResponse.json({
    outcome: "nothingToReset", message: "预览环境不会执行真实的额度重置", detail: null, usage: usage(String(params.id)),
  })),
  http.get("/api/token-usage", ({ request }) => HttpResponse.json(
    tokenUsageReport(Number(new URL(request.url).searchParams.get("days") ?? 30), db.user.id))),
  http.get("/api/agent/models", ({ request }) =>
    HttpResponse.json({ models: models[new URL(request.url).searchParams.get("engine") || "claude"] || [], refreshedAt: timestamp(-60) })),
  http.get("/api/settings/agent", () => HttpResponse.json(agentSettings())),
  http.put("/api/settings/agent/:engine", async ({ params, request }) => {
    const engine = params.engine === "codex" ? "codex" : "claude";
    db.agentDefaults = { ...db.agentDefaults, [engine]: await readBody<AgentPreference>(request) };
    emit({ type: "agent-defaults", payload: {} });
    return HttpResponse.json(agentSettings());
  }),
  http.post("/api/slots/:id/models/refresh", ({ params }) => {
    const slot = db.slots.find((item) => item.id === params.id);
    if (!slot) return fail(404, "槽位不存在");
    slot.model_catalog_at = timestamp();
    return HttpResponse.json({ models: models[slot.engine] || [], refreshedAt: slot.model_catalog_at });
  }),

  http.get("/api/hosts", () => HttpResponse.json(db.hosts)),
  http.post("/api/hosts", async ({ request }) => {
    const input = await readBody<{ name?: string; host?: string; port?: number; username?: string }>(request);
    const host: DevHost = {
      id: crypto.randomUUID(), kind: "ssh", name: input.name || input.host || "新开发机", host: input.host || "example.com",
      port: input.port || 22, username: input.username || "developer", status: "DISCONNECTED",
    };
    db.hosts.push(host);
    return HttpResponse.json(host, { status: 201 });
  }),
  http.patch("/api/hosts/:id", async ({ params, request }) => {
    const host = db.hosts.find((item) => item.id === params.id);
    if (!host) return fail(404, "开发机不存在");
    const input = await readBody<Partial<DevHost>>(request);
    Object.assign(host, { name: input.name ?? host.name, host: input.host ?? host.host, port: input.port ?? host.port, username: input.username ?? host.username });
    return HttpResponse.json(host);
  }),
  http.delete("/api/hosts/:id", ({ params }) => {
    if (db.projects.some((project) => project.dev_host_id === params.id)) return fail(409, "请先删除该开发机上的项目");
    db.hosts = db.hosts.filter((host) => host.id !== params.id || host.kind === "local");
    return ok();
  }),
  http.post("/api/hosts/:id/connect", ({ params }) => {
    const host = db.hosts.find((item) => item.id === params.id);
    if (!host) return fail(404, "开发机不存在");
    if (host.kind !== "local") Object.assign(host, { status: "CONNECTED", fingerprint: "SHA256:demo+fingerprint+for+preview" });
    return HttpResponse.json({ status: host.status, fingerprint: host.fingerprint });
  }),
  http.post("/api/hosts/test", async ({ request }) => {
    const input = await readBody<{ host?: string; jumpHost?: { host?: string } | null }>(request);
    if (input.jumpHost?.host?.includes("fail"))
      return fail(422, `跳板机 developer@${input.jumpHost.host}:22 连接失败：\nssh: connect to host ${input.jumpHost.host} port 22: Connection refused`);
    if (input.host?.includes("fail"))
      return fail(422, `开发机 developer@${input.host}:22 连接失败：\ndeveloper@${input.host}: Permission denied (publickey).`);
    return HttpResponse.json({
      status: "CONNECTED", fingerprint: "SHA256:demo+fingerprint+for+preview",
      ...(input.jumpHost ? { jumpFingerprint: "SHA256:demo+jump+fingerprint" } : {}),
    });
  }),
  http.get("/api/hosts/:id/directories", ({ params, request }) => {
    const host = db.hosts.find((item) => item.id === params.id);
    const path = new URL(request.url).searchParams.get("path") || (host?.kind === "local" ? "/srv" : `/home/${host?.username || "developer"}`);
    return HttpResponse.json({ path, entries: remoteDirectories(path) });
  }),
  http.post("/api/hosts/:id/sync-scan", async ({ request }) => {
    const { remotePath = "/" } = await readBody<{ remotePath?: string }>(request);
    return HttpResponse.json({
      remotePath, totalBytes: 48_600_000, totalFiles: 1_284, truncated: false,
      entries: [
        { path: "src", type: "directory", bytes: 2_400_000, files: 214, tracked: true },
        { path: "node_modules", type: "directory", bytes: 45_800_000, files: 1_060, tracked: false },
        { path: "README.md", type: "file", bytes: 4_200, files: 1, tracked: true },
      ],
    });
  }),

  http.get("/api/projects", () => HttpResponse.json(db.projects)),
  http.post("/api/projects", async ({ request }) => {
    const input = await readBody<{ name?: string; devHostId?: string; remotePath?: string }>(request);
    const host = db.hosts.find((item) => item.id === input.devHostId);
    if (!host) return fail(400, "请选择开发机");
    const name = input.name || "new-project";
    const local = host.kind === "local";
    const project: Project = {
      id: crypto.randomUUID(), name, dev_host_id: host.id, remote_path: input.remotePath || `/home/${host.username}/${name}`,
      local_path: local ? input.remotePath || `/srv/${name}` : `/data/mirrors/${name}`, path_mode: "auto",
      execution_mode: local ? "local" : null, sync_status: local ? "LOCAL" : "CREATING",
    };
    db.projects.push(project);
    emit({ type: "project", payload: { id: project.id } });
    if (local) return HttpResponse.json(project, { status: 201 });
    firstSyncs.set(project.id, Date.now());
    setTimeout(() => {
      firstSyncs.delete(project.id);
      Object.assign(project, { sync_status: "WATCHING", execution_mode: "direct" });
      emit({ type: "project", payload: { id: project.id } });
    }, firstSyncDuration);
    return HttpResponse.json(project, { status: 202 });
  }),
  http.get("/api/projects/:id/sync-progress", ({ params }) => {
    const started = firstSyncs.get(String(params.id));
    if (started === undefined) return HttpResponse.json(null);
    const elapsed = (Date.now() - started) / firstSyncDuration;
    if (elapsed < 0.2) return HttpResponse.json({ description: "正在准备远端目录和同步规则", ratio: null });
    if (elapsed < 0.35) return HttpResponse.json({ description: "正在扫描文件", ratio: null });
    const ratio = Math.min(1, (elapsed - 0.35) / 0.55);
    return HttpResponse.json({
      description: ratio < 1 ? "正在向镜像传输文件" : "正在应用文件变更", ratio,
      receivedFiles: Math.round(ratio * 1284), expectedFiles: 1284,
      receivedBytes: Math.round(ratio * firstSyncBytes), totalBytes: firstSyncBytes,
    });
  }),
  http.patch("/api/projects/:id", async ({ params, request }) => {
    const project = findProject(params.id);
    if (!project) return fail(404, "项目不存在");
    const { pathMode } = await readBody<{ pathMode?: Project["path_mode"] }>(request);
    if (pathMode) project.path_mode = pathMode;
    return HttpResponse.json(project);
  }),
  http.delete("/api/projects/:id", ({ params }) => {
    db.projects = db.projects.filter((project) => project.id !== params.id);
    db.sessions = db.sessions.filter((session) => session.project_id !== params.id);
    return ok();
  }),
  http.post("/api/projects/:id/sync", () => ok()),
  http.get("/api/projects/:id/sync-rules", ({ params }) =>
    HttpResponse.json({ rules: syncRules.get(String(params.id)) ?? "", defaults: demoDefaultIgnores })),
  http.put("/api/projects/:id/sync-rules", async ({ params, request }) => {
    const project = findProject(params.id);
    if (!project) return fail(404, "项目不存在");
    const { rules } = await readBody<{ rules: string }>(request);
    syncRules.set(project.id, rules);
    return HttpResponse.json(project, { status: 202 });
  }),
  http.get("/api/projects/:id/usage", () => HttpResponse.json({ mirrorBytes: 2_404_200 })),
  http.get("/api/projects/:id/files", ({ request }) =>
    HttpResponse.json({ entries: listFiles(new URL(request.url).searchParams.get("path") || "") })),
  http.get("/api/projects/:id/file", ({ request }) => {
    const meta = fileMeta(new URL(request.url).searchParams.get("path") || "");
    return meta ? HttpResponse.json(meta) : fail(404, "文件不存在");
  }),
  http.get("/api/projects/:id/raw", ({ request }) => {
    const query = new URL(request.url).searchParams;
    const path = query.get("path") || "";
    const content = readFile(path);
    if (content === undefined) return fail(404, "文件不存在");
    const name = path.split("/").pop() || "file";
    const download = query.get("download") === "1";
    const types: Record<string, string> = { svg: "image/svg+xml", pdf: "application/pdf" };
    // The sample PDF is ASCII, so encoding it as UTF-8 yields the exact bytes.
    return new HttpResponse(new TextEncoder().encode(content), {
      headers: {
        "Content-Type": download ? "application/octet-stream" : types[name.split(".").pop() ?? ""] ?? "application/octet-stream",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  }),
  http.put("/api/projects/:id/transfers/:transfer", async ({ request, params }) => {
    const query = new URL(request.url).searchParams;
    const path = query.get("path") || "";
    const offset = Number(query.get("offset"));
    const size = Number(query.get("size"));
    const transfer = String(params.transfer);
    if (offset === 0) {
      const refused = refusedWrite(request, path);
      if (refused) return refused;
    }
    const chunks = offset === 0 ? [] : transfers.get(transfer);
    if (!chunks) return fail(409, "上传已失效，请重新上传");
    chunks.push(new Uint8Array(await request.arrayBuffer()));
    const received = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (received < size) {
      transfers.set(transfer, chunks);
      return HttpResponse.json({ received });
    }
    transfers.delete(transfer);
    const refused = refusedWrite(request, path);
    if (refused) return refused;
    const bytes = new Uint8Array(received);
    chunks.reduce((position, chunk) => (bytes.set(chunk, position), position + chunk.length), 0);
    const { size: written, mtime, etag } = writeFile(path, bytes);
    return HttpResponse.json({ received, file: { path, size: written, mtime, etag } });
  }),
  http.delete("/api/projects/:id/transfers/:transfer", ({ params }) => {
    transfers.delete(String(params.transfer));
    return ok();
  }),
  http.get("/api/projects/:id/git", () => HttpResponse.json(gitState())),
  http.get("/api/projects/:id/completions", ({ request }) =>
    HttpResponse.json({ entries: completePaths(new URL(request.url).searchParams.get("query") || ""), truncated: false })),
];
