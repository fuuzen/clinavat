import { http, HttpResponse } from "msw";
import { db } from "../store";
import { fail, ok, readBody } from "./respond";

const health = {
  status: "ok",
  version: "demo",
  runtime: { claude: true, codex: true, mutagen: true, ssh: true },
};

export const authHandlers = [
  http.get("/api/auth/status", () => HttpResponse.json({ needsSetup: false, registrationEnabled: true })),
  http.post("/api/auth/:mode", async ({ params, request }) => {
    if (params.mode === "logout") {
      db.signedIn = false;
      return ok();
    }
    const { username } = await readBody<{ username?: string }>(request);
    if (!username?.trim()) return fail(400, "请输入用户名");
    db.user.username = username.trim();
    db.signedIn = true;
    return HttpResponse.json({ user: db.user });
  }),
  http.get("/api/auth/me", () => db.signedIn ? HttpResponse.json({ user: db.user, slots: db.slots }) : fail(401, "请先登录")),
  http.get("/api/site/settings", () => HttpResponse.json(db.siteSettings)),
  http.get("/api/health", () => HttpResponse.json(health)),
];
