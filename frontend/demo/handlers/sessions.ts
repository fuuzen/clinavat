import { http, HttpResponse } from "msw";
import type { Session } from "../../src/types";
import type { CodexGoal } from "../../src/components/chat/native/useCodexGoal";
import { answerQuestion, asPayload, controlRun, decideApproval, isRunning, startRun } from "../agent";
import { emit } from "../events";
import { db, findSession, timestamp, touchSession } from "../store";
import { fail, ok, readBody } from "./respond";

interface SessionInput {
  projectId?: string;
  engine?: Session["engine"];
  slotId?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: Session["permission_mode"];
  agentMode?: Session["agent_mode"];
  rolePreset?: Session["role_preset"];
  title?: string;
  content?: string;
}

const goals = new Map<string, CodexGoal>();
const busyMessage = "对话仍在运行，请等待结束或先停止后修改";

function goalAction(sessionId: string, action: string, objective?: string): CodexGoal | null {
  const current = goals.get(sessionId);
  const now = Math.floor(Date.now() / 1000);
  if (action === "create" || (action === "edit" && current)) {
    goals.set(sessionId, {
      threadId: sessionId, objective: objective || current?.objective || "", status: "active", tokenBudget: null,
      tokensUsed: current?.tokensUsed ?? 0, timeUsedSeconds: current?.timeUsedSeconds ?? 0, createdAt: current?.createdAt ?? now, updatedAt: now,
    });
  } else if (current && (action === "pause" || action === "resume")) {
    Object.assign(current, { status: action === "pause" ? "paused" : "active", updatedAt: now });
  }
  const goal = goals.get(sessionId) ?? null;
  emit({ type: "goal", sessionId, payload: { goal } });
  return goal;
}

export const sessionHandlers = [
  http.post("/api/sessions", async ({ request }) => {
    const input = await readBody<SessionInput>(request);
    if (!db.projects.some((project) => project.id === input.projectId)) return fail(400, "项目不存在");
    const session: Session = {
      id: crypto.randomUUID(), project_id: input.projectId!, engine: input.engine || "claude", slot_id: input.slotId || null,
      title: input.title || "新对话", status: "idle", updated_at: timestamp(), model: input.model ?? null,
      reasoning_effort: input.reasoningEffort ?? null, permission_mode: input.permissionMode ?? "manual",
      agent_mode: input.agentMode ?? "normal", role_preset: input.rolePreset ?? "default",
    };
    db.sessions.unshift(session);
    return HttpResponse.json(session, { status: 201 });
  }),
  http.patch("/api/sessions/:id", async ({ params, request }) => {
    const id = String(params.id);
    const input = await readBody<SessionInput>(request);
    if (!findSession(id)) return fail(404, "对话不存在");
    const settingsChanged = [input.permissionMode, input.agentMode, input.rolePreset, input.slotId].some((value) => value !== undefined);
    if (settingsChanged && isRunning(id)) return fail(409, busyMessage);
    const session = touchSession(id, Object.fromEntries(Object.entries({
      title: input.title, permission_mode: input.permissionMode, agent_mode: input.agentMode,
      role_preset: input.rolePreset, slot_id: input.slotId,
    }).filter(([, value]) => value !== undefined)));
    emit({ type: "session", sessionId: id, payload: asPayload(session!) });
    return HttpResponse.json(session);
  }),
  http.delete("/api/sessions/:id", ({ params }) => {
    if (isRunning(String(params.id))) return fail(409, "请等待会话结束，或先停止会话");
    db.sessions = db.sessions.filter((session) => session.id !== params.id);
    return ok();
  }),
  http.get("/api/sessions/:id/messages", ({ params }) =>
    HttpResponse.json(db.messages.filter((message) => message.session_id === params.id))),
  http.get("/api/sessions/:id/turns", ({ params }) =>
    HttpResponse.json(db.turns.filter((turn) => turn.session_id === params.id))),
  http.post("/api/sessions/:id/messages", async ({ params, request }) => {
    const session = findSession(String(params.id));
    if (!session) return fail(404, "对话不存在");
    const input = await readBody<SessionInput>(request);
    if (!input.content?.trim()) return fail(400, "请输入消息内容");
    if (isRunning(session.id)) return fail(409, "对话仍在运行，请等待结束或先停止。");
    Object.assign(session, {
      model: input.model ?? session.model, reasoning_effort: input.reasoningEffort ?? session.reasoning_effort,
      permission_mode: input.permissionMode ?? session.permission_mode,
      agent_mode: input.agentMode ?? session.agent_mode, role_preset: input.rolePreset ?? session.role_preset,
    });
    startRun(session, input.content.trim());
    return HttpResponse.json({ ok: true }, { status: 202 });
  }),
  ...(["pause", "resume", "stop"] as const).map((action) => http.post(`/api/sessions/:id/${action}`, ({ params }) => {
    const status = controlRun(String(params.id), action);
    return HttpResponse.json(action === "stop" ? { ok: true } : { status });
  })),
  http.get("/api/sessions/:id/questions", ({ params }) =>
    HttpResponse.json(db.questions.filter((question) => question.session_id === params.id))),
  http.post("/api/sessions/:id/questions/:requestId", async ({ params, request }) => {
    const { answers = {} } = await readBody<{ answers?: Record<string, string[]> }>(request);
    return answerQuestion(String(params.requestId), answers) ? ok() : fail(404, "问题已失效");
  }),
  http.get("/api/sessions/:id/goal", ({ params }) => HttpResponse.json({ goal: goals.get(String(params.id)) ?? null })),
  http.post("/api/sessions/:id/goal", async ({ params, request }) => {
    const { action = "create", objective } = await readBody<{ action?: string; objective?: string }>(request);
    return HttpResponse.json({ goal: goalAction(String(params.id), action, objective) });
  }),
  http.get("/api/approvals", () => HttpResponse.json(db.approvals)),
  http.post("/api/approvals/:id", async ({ params, request }) => {
    const { decision, reason } = await readBody<{ decision?: string; reason?: string }>(request);
    return decideApproval(String(params.id), decision === "allow", reason) ? ok() : fail(404, "审批已失效");
  }),
];
