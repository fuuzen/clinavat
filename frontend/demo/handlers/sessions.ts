import { http, HttpResponse } from "msw";
import type { Session, Slot, SlotMode } from "../../src/types";
import type { CodexGoal } from "../../src/components/chat/native/useCodexGoal";
import { answerQuestion, asPayload, controlRun, decideApproval, isRunning, startRun } from "../agent";
import { emit } from "../events";
import { db, findSession, timestamp, touchSession } from "../store";
import { fail, ok, readBody } from "./respond";

interface SessionInput {
  projectId?: string;
  engine?: Session["engine"];
  slotId?: string;
  slotMode?: SlotMode;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: Session["permission_mode"];
  agentMode?: Session["agent_mode"];
  rolePreset?: Session["role_preset"];
  questionMode?: Session["question_mode"];
  questionTimeoutMs?: Session["question_timeout_ms"];
  title?: string;
  content?: string;
  mode?: "steer" | "queue" | "interrupt";
}

const goals = new Map<string, CodexGoal>();
const busyMessage = "对话仍在运行，请等待结束或先停止后修改";

function chooseSlot(engine: Session["engine"], mode: SlotMode, slotId?: string | null): Slot | undefined {
  const usable = db.slots.filter(slot => slot.engine === engine && slot.status === "IDLE" && (!slot.in_use || slot.in_use_by_you));
  const selected = usable.find(slot => slot.id === slotId);
  return mode === "auto" ? selected ?? usable[0] : selected;
}

function invalidMode(engine: Session["engine"], mode: SlotMode): boolean {
  return !["manual", "auto"].includes(mode) || mode === "auto" && engine !== "claude";
}

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
    const engine = input.engine ?? "claude";
    const slotMode = input.slotMode ?? "manual";
    if (invalidMode(engine, slotMode)) return fail(400, "自动选择仅适用于 Claude 对话");
    if (slotMode === "auto" && input.slotId !== undefined) return fail(400, "自动选择时无需指定账号");
    const slot = chooseSlot(engine, slotMode, input.slotId);
    if (!slot) return fail(409, "当前没有可用的授权账号");
    const session: Session = {
      id: crypto.randomUUID(), project_id: input.projectId!, engine, slot_mode: slotMode, slot_id: slot.id,
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
    const current = findSession(id);
    if (!current) return fail(404, "对话不存在");
    const settingsChanged = [input.permissionMode, input.agentMode, input.rolePreset, input.slotId, input.slotMode].some((value) => value !== undefined);
    if (settingsChanged && isRunning(id)) return fail(409, busyMessage);
    const slotMode = input.slotMode ?? (input.slotId !== undefined ? "manual" : current.slot_mode);
    if (invalidMode(current.engine, slotMode)) return fail(400, "自动选择仅适用于 Claude 对话");
    if (slotMode === "auto" && input.slotId !== undefined) return fail(400, "自动选择时无需指定账号");
    if (slotMode === "manual" && (input.slotId !== undefined || input.slotMode !== undefined)
      && !chooseSlot(current.engine, slotMode, input.slotId ?? current.slot_id)) return fail(409, "所选授权账号不可用");
    const changedSlot = input.slotId !== undefined && input.slotId !== current.slot_id;
    const session = touchSession(id, Object.fromEntries(Object.entries({
      title: input.title, permission_mode: input.permissionMode, agent_mode: input.agentMode,
      role_preset: input.rolePreset, slot_id: input.slotId, slot_mode: slotMode,
      question_mode: input.questionMode, question_timeout_ms: input.questionTimeoutMs,
      ...(changedSlot ? { model: null, reasoning_effort: null } : {}),
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
  http.get("/api/sessions/:id/runtime", () =>
    HttpResponse.json({ resident: false, turnActive: false, queue: [], tasks: [] })),
  http.get("/api/sessions/:id/turns", ({ params }) =>
    HttpResponse.json(db.turns.filter((turn) => turn.session_id === params.id))),
  http.post("/api/sessions/:id/messages", async ({ params, request }) => {
    const session = findSession(String(params.id));
    if (!session) return fail(404, "对话不存在");
    const input = await readBody<SessionInput>(request);
    if (!input.content?.trim()) return fail(400, "请输入消息内容");
    if (session.slot_mode === "auto" && input.slotId !== undefined) return fail(400, "自动选择时无需指定账号");
    if (isRunning(session.id)) {
      // The demo agent follows a script, so it only records guidance sent during a reply.
      if (input.mode && input.mode !== "steer") return fail(409, "演示环境仅支持以「引导」方式在运行中发送。");
      const message = { id: crypto.randomUUID(), session_id: session.id, role: "user" as const, content: input.content.trim(), created_at: timestamp() };
      db.messages.push(message);
      emit({ type: "message", sessionId: session.id, payload: message });
      return HttpResponse.json({ sessionId: session.id, status: "steered" });
    }
    const slot = chooseSlot(session.engine, session.slot_mode, input.slotId ?? session.slot_id);
    if (!slot) return fail(409, "当前没有可用的授权账号");
    Object.assign(session, {
      slot_id: slot.id,
      model: input.model === undefined ? session.model : input.model,
      reasoning_effort: input.reasoningEffort === undefined ? session.reasoning_effort : input.reasoningEffort,
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
