import { http, HttpResponse } from "msw";
import type { AgentModel, DevHost, Project, SlotUsage } from "../../src/types";
import { completePaths, fileMeta, gitState, listFiles, readFile, remoteDirectories } from "../filesystem";
import { emit } from "../events";
import { db } from "../store";
import { fail, ok, readBody } from "./respond";

const efforts = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
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
  return {
    slotId, state: "ok", plan: "Max", credits: null, limited: false, observedAt: now, checkedAt: now,
    source: "query", stale: false, refreshing: false, error: null,
    windows: [
      { key: "five_hour", label: "5 小时", usedPercent: 37, resetsAt: inHours(3), windowMinutes: 300 },
      { key: "seven_day", label: "7 天", usedPercent: 62, resetsAt: inHours(80), windowMinutes: 10_080 },
    ],
  };
}

function findProject(id: unknown): Project | undefined {
  return db.projects.find((project) => project.id === id);
}

export const workspaceHandlers = [
  http.get("/api/overview", () => db.signedIn
    ? HttpResponse.json({ user: db.user, slots: db.slots, hosts: db.hosts, projects: db.projects, sessions: db.sessions })
    : fail(401, "请先登录")),
  http.get("/api/slots", () => HttpResponse.json(db.slots)),
  http.get("/api/slots/usage", () => HttpResponse.json(Object.fromEntries(db.slots.map((slot) => [slot.id, usage(slot.id)])))),
  http.post("/api/slots/:id/usage/refresh", ({ params }) => HttpResponse.json(usage(String(params.id)))),
  http.get("/api/agent/models", ({ request }) =>
    HttpResponse.json({ models: models[new URL(request.url).searchParams.get("engine") || "claude"] || [] })),

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
  http.get("/api/hosts/:id/directories", ({ request }) => {
    const path = new URL(request.url).searchParams.get("path") || "/";
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
      execution_mode: local ? "local" : "direct", sync_status: local ? "LOCAL" : "WATCHING",
    };
    db.projects.push(project);
    emit({ type: "project", payload: { id: project.id } });
    return HttpResponse.json(project, { status: 201 });
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
  http.get("/api/projects/:id/usage", () => HttpResponse.json({ mirrorBytes: 2_404_200, backupBytes: 0 })),
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
  http.get("/api/projects/:id/git", () => HttpResponse.json(gitState())),
  http.get("/api/projects/:id/completions", ({ request }) =>
    HttpResponse.json({ entries: completePaths(new URL(request.url).searchParams.get("query") || ""), truncated: false })),
];
