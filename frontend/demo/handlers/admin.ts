import { http, HttpResponse } from "msw";
import { withSiteDefaults, type SiteSettings } from "../../src/site/settings";
import type { ModelPrice, ModelPriceList, QuestionPolicy, QuestionPreference, Slot, User } from "../../src/types";
import { db, timestamp } from "../store";
import { tokenUsageReport } from "../token-usage";
import { fail, readBody, unavailable } from "./respond";

const snapshotPrices: Record<string, ModelPrice> = {
  "claude-haiku-5-5": [0.1, 0.01, 0.125, 0.5], "claude-opus-5-5": [4, 0.2, 5, 20],
  "claude-sonnet-5-5": [2, 0.1, 2.5, 10], "gpt-6-sol": [2, 0.2, 2.5, 10],
};
const customPrices: Record<string, ModelPrice> = {};

function priceList(): ModelPriceList {
  const models = [...new Set([...Object.keys(snapshotPrices), ...Object.keys(customPrices)])].sort();
  return {
    snapshot: { source: "bundled", date: "2026-11-11", models: Object.keys(snapshotPrices).length },
    entries: models.map((model) => ({ model, price: customPrices[model] ?? snapshotPrices[model], snapshot: snapshotPrices[model] ?? null, custom: model in customPrices })),
    unpricedModels: [],
  };
}

export const adminHandlers = [
  http.get("/api/admin/users", () => HttpResponse.json(db.users)),
  http.post("/api/admin/users", async ({ request }) => {
    const { username } = await readBody<{ username?: string }>(request);
    if (!username?.trim()) return fail(400, "请输入用户名");
    if (db.users.some((user) => user.username === username.trim())) return fail(409, "用户名已存在");
    const user: User = { id: crypto.randomUUID(), username: username.trim(), role: "user", created_at: timestamp() };
    db.users.push(user);
    return HttpResponse.json({ user }, { status: 201 });
  }),
  http.get("/api/admin/resources", ({ request }) => {
    const userId = new URL(request.url).searchParams.get("userId");
    const user = db.users.find((item) => item.id === userId);
    if (!user) return fail(404, "用户不存在");
    const own = user.id === db.user.id;
    const projects = own ? db.projects : [];
    return HttpResponse.json({
      user, hosts: own ? db.hosts : [], projects,
      sessionCounts: Object.fromEntries(projects.map((project) =>
        [project.id, db.sessions.filter((session) => session.project_id === project.id).length])),
    });
  }),
  http.get("/api/admin/slots", () => HttpResponse.json(db.slots)),
  http.post("/api/admin/slots", async ({ request }) => {
    const input = await readBody<{ id?: string; label?: string; engine?: Slot["engine"] }>(request);
    const engine = input.engine || "claude";
    const slot: Slot = {
      id: input.id || crypto.randomUUID(), label: input.label || "新槽位", engine, status: "IDLE", auth_method: "oauth", allowed_user_ids: [],
      max_concurrent_users: 1, in_use: false, in_use_by_you: false, active_user_id: null,
      home_dir: `/data/slots/${input.id || engine}`, credential_revision: 1, updated_at: timestamp(),
    };
    db.slots.push(slot);
    return HttpResponse.json(slot, { status: 201 });
  }),
  http.post("/api/admin/slots/:id/login-command", ({ params }) => HttpResponse.json({
    runsIn: "vm",
    command: `lxc exec clinavat-host:s-demo --project clinavat -t -- setpriv --reuid=1000 --regid=1000 --clear-groups -- claude auth login  # ${String(params.id)}`,
  })),
  http.put("/api/admin/slots/:id/setup-token", async ({ params, request }) => {
    const slot = db.slots.find((item) => item.id === params.id);
    if (!slot) return fail(404, "槽位不存在");
    if (slot.engine !== "claude") return fail(400, "只有 Claude Code 槽位支持长期令牌");
    const { token, validDays = 365 } = await readBody<{ token?: string; validDays?: number }>(request);
    if (!/^sk-ant-oat[A-Za-z0-9_-]{20,500}$/.test(token?.trim() || "")) return fail(400, "请粘贴 claude setup-token 输出的完整令牌（以 sk-ant-oat 开头）");
    Object.assign(slot, { auth_method: "token", token_expires_at: timestamp(validDays * 24 * 60),
      credential_revision: slot.credential_revision + 1, updated_at: timestamp() });
    return HttpResponse.json(slot);
  }),
  http.delete("/api/admin/slots/:id/setup-token", ({ params }) => {
    const slot = db.slots.find((item) => item.id === params.id);
    if (!slot) return fail(404, "槽位不存在");
    Object.assign(slot, { auth_method: "oauth", token_expires_at: null, credential_revision: slot.credential_revision + 1, updated_at: timestamp() });
    return HttpResponse.json(slot);
  }),
  http.patch("/api/admin/slots/:id", async ({ params, request }) => {
    const slot = db.slots.find((item) => item.id === params.id);
    if (!slot) return fail(404, "槽位不存在");
    const input = await readBody<{ label?: string; status?: Slot["status"]; allowedUserIds?: string[] }>(request);
    Object.assign(slot, {
      label: input.label ?? slot.label, status: input.status ?? slot.status,
      allowed_user_ids: input.allowedUserIds ?? slot.allowed_user_ids, updated_at: timestamp(),
    });
    slot.credential_revision += 1;
    return HttpResponse.json(slot);
  }),
  http.get("/api/admin/token-usage", ({ request }) => HttpResponse.json(
    tokenUsageReport(Number(new URL(request.url).searchParams.get("days") ?? 30)))),
  http.get("/api/admin/model-prices", () => HttpResponse.json(priceList())),
  http.put("/api/admin/model-prices/overrides", async ({ request }) => {
    const input = await readBody<{ model: string; input: number; cacheRead: number | null; cacheWrite: number | null; output: number }>(request);
    customPrices[input.model.trim().toLowerCase()] = [input.input, input.cacheRead, input.cacheWrite, input.output];
    return HttpResponse.json(priceList());
  }),
  http.delete("/api/admin/model-prices/overrides", ({ request }) => {
    delete customPrices[new URL(request.url).searchParams.get("model") ?? ""];
    return HttpResponse.json(priceList());
  }),
  http.all("/api/admin/model-prices/snapshot", () => unavailable("导入价格快照")),
  http.get("/api/admin/site/settings", () => HttpResponse.json(db.siteSettings)),
  http.put("/api/admin/site/settings", async ({ request }) => {
    db.siteSettings = withSiteDefaults(await readBody<SiteSettings>(request));
    return HttpResponse.json(db.siteSettings);
  }),
  http.get("/api/admin/settings/questions", () => HttpResponse.json(db.siteQuestions)),
  http.put("/api/admin/settings/questions", async ({ request }) => {
    db.siteQuestions = await readBody<QuestionPolicy>(request);
    return HttpResponse.json(db.siteQuestions);
  }),
  http.get("/api/settings/questions", () => HttpResponse.json({ site: db.siteQuestions, user: db.userQuestions })),
  http.put("/api/settings/questions", async ({ request }) => {
    db.userQuestions = await readBody<QuestionPreference>(request);
    return HttpResponse.json({ site: db.siteQuestions, user: db.userQuestions });
  }),
  http.get("/api/admin/site-access", () => HttpResponse.json(db.siteAccess)),
  http.patch("/api/admin/site-access", async ({ request }) => {
    const { publicUrls } = await readBody<{ publicUrls?: string[] }>(request);
    db.siteAccess = { ...db.siteAccess, publicUrls: publicUrls ?? db.siteAccess.publicUrls, revision: db.siteAccess.revision + 1 };
    return HttpResponse.json(db.siteAccess);
  }),
  http.all("/api/admin/gateway/*", () => unavailable("管理上游网关")),
  http.get("/api/admin/gateway", () => unavailable("管理上游网关")),
];
