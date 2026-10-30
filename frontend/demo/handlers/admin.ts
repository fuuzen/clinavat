import { http, HttpResponse } from "msw";
import { withSiteDefaults, type SiteSettings } from "../../src/site/settings";
import type { Slot, User } from "../../src/types";
import { db, timestamp } from "../store";
import { fail, readBody, unavailable } from "./respond";

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
      id: input.id || crypto.randomUUID(), label: input.label || "新槽位", engine, status: "IDLE", allowed_user_ids: [],
      max_concurrent_users: 1, in_use: false, in_use_by_you: false, active_user_id: null,
      home_dir: `/data/slots/${input.id || engine}`, credential_revision: 1, updated_at: timestamp(),
    };
    db.slots.push(slot);
    return HttpResponse.json(slot, { status: 201 });
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
  http.get("/api/admin/site/settings", () => HttpResponse.json(db.siteSettings)),
  http.put("/api/admin/site/settings", async ({ request }) => {
    db.siteSettings = withSiteDefaults(await readBody<SiteSettings>(request));
    return HttpResponse.json(db.siteSettings);
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
