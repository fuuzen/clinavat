import type { ActivityItem, Session, ToolEvent, Turn } from "../src/types";
import { emit } from "./events";
import { db, findSession, timestamp, touchSession, type DemoMessage } from "./store";

interface Run {
  turn: Turn;
  stopped: boolean;
  paused: boolean;
  wake?: () => void;
  interrupt?: () => void;
}

class Interrupted extends Error {}

const runs = new Map<string, Run>();
const approvalWaiters = new Map<string, (decision: { allow: boolean; reason?: string }) => void>();
const questionWaiters = new Map<string, (answers: Record<string, string[]>) => void>();

export const asPayload = (value: object) => value as unknown as Record<string, unknown>;

function publishTurn(run: Run) {
  emit({ type: "turn", sessionId: run.turn.session_id, payload: asPayload(structuredClone(run.turn)) });
}

function publishSession(sessionId: string, status: string) {
  const session = touchSession(sessionId, { status });
  if (session) emit({ type: "session", sessionId, payload: asPayload(session) });
}

function setSlotBusy(session: Session, busy: boolean) {
  const slot = db.slots.find((item) => item.id === session.slot_id);
  if (!slot) return;
  Object.assign(slot, { in_use: busy, in_use_by_you: busy, active_user_id: busy ? db.user.id : null });
  emit({ type: "slot", payload: asPayload(slot) });
}

async function step(run: Run, milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  while (run.paused && !run.stopped) await new Promise<void>((resolve) => (run.wake = resolve));
  if (run.stopped) throw new Interrupted();
}

/** Resolves when the user answers, or rejects as soon as the run is stopped. */
function waitFor<T>(run: Run, register: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    run.interrupt = () => reject(new Interrupted());
    register(resolve);
  }).finally(() => (run.interrupt = undefined));
}

function upsert(run: Run, item: ActivityItem) {
  const index = run.turn.items.findIndex((existing) => existing.id === item.id);
  if (index < 0) run.turn.items.push(item);
  else run.turn.items[index] = item;
  publishTurn(run);
}

function upsertTool(run: Run, tool: ToolEvent) {
  upsert(run, { id: tool.id, kind: "tool", tool });
}

async function streamText(run: Run, id: string, text: string, final: boolean) {
  for (let end = 12; ; end += 12) {
    upsert(run, { id, kind: "text", text: text.slice(0, end), final });
    if (end >= text.length) return;
    await step(run, 60);
  }
}

async function requestApproval(run: Run, session: Session, tool: ToolEvent) {
  const approval = { id: crypto.randomUUID(), session_id: session.id, tool: tool.name, input: tool.input, status: "pending", created_at: timestamp() };
  db.approvals.push(approval);
  upsertTool(run, { ...tool, status: "waiting" });
  publishSession(session.id, "waiting");
  emit({ type: "approval", sessionId: session.id, payload: asPayload(approval) });
  const decision = await waitFor<{ allow: boolean; reason?: string }>(run, (resolve) => approvalWaiters.set(approval.id, resolve))
    .finally(() => {
      approvalWaiters.delete(approval.id);
      db.approvals = db.approvals.filter((item) => item.id !== approval.id);
    });
  publishSession(session.id, "running");
  return decision;
}

async function askQuestion(run: Run, session: Session) {
  const request = {
    id: crypto.randomUUID(),
    session_id: session.id,
    questions: [{
      id: "scope", header: "范围", question: "这次改动希望覆盖到哪些部分？",
      options: [
        { label: "只改核心逻辑", description: "保持改动最小" },
        { label: "顺带整理相关代码", description: "允许适度重构" },
      ],
    }],
  };
  db.questions.push(request);
  emit({ type: "user-input", sessionId: session.id, payload: asPayload(request) });
  await waitFor<Record<string, string[]>>(run, (resolve) => questionWaiters.set(request.id, resolve))
    .finally(() => {
      questionWaiters.delete(request.id);
      db.questions = db.questions.filter((item) => item.id !== request.id);
    });
}

async function script(run: Run, session: Session, content: string) {
  const claude = session.engine === "claude";
  const topic = content.replace(/\s+/g, " ").slice(0, 60);
  await step(run, 400);
  upsert(run, { id: "reasoning", kind: "reasoning", text: `需求是「${topic}」。先读入口文件确认现有结构，再做最小改动并运行检查。` });
  await step(run, 700);
  const read: ToolEvent = claude
    ? { id: "read", name: "Read", input: { file_path: "src/app.ts" }, status: "running" }
    : { id: "read", name: "shell", input: { command: "sed -n 1,40p src/app.ts" }, status: "running" };
  upsertTool(run, read);
  await step(run, 600);
  upsertTool(run, { ...read, status: "completed", output: "export function createApp(config: AppConfig) {\n  const router = createRouter();\n  return { router, config };\n}" });
  if (session.agent_mode === "plan") await askQuestion(run, session);
  const edit: ToolEvent = {
    id: "edit", name: claude ? "Edit" : "apply_patch", status: "running",
    input: { file_path: "src/app.ts", old_string: "  return { router, config };", new_string: "  router.use(requestLogger(config.logLevel));\n  return { router, config };" },
  };
  upsertTool(run, edit);
  const decision = session.permission_mode === "manual" ? await requestApproval(run, session, edit) : { allow: true };
  await step(run, 400);
  upsertTool(run, decision.allow
    ? { ...edit, status: "completed", output: "已修改 src/app.ts" }
    : { ...edit, status: "denied", output: decision.reason || "用户拒绝了此操作" });
  const check: ToolEvent = { id: "check", name: claude ? "Bash" : "shell", input: { command: "npm run typecheck" }, status: "running", output: "" };
  upsertTool(run, check);
  for (const line of ["> demo@1.0.0 typecheck\n", "> tsc -b\n", "\n", "✓ 0 errors\n"]) {
    await step(run, 350);
    check.output += line;
    upsertTool(run, { ...check });
  }
  upsertTool(run, { ...check, status: "completed" });
  await step(run, 300);
  const answer = [
    `已完成「${topic}」：`,
    "",
    decision.allow ? "- 在 `src/app.ts` 中接入了请求日志中间件；" : "- 修改被拒绝，代码保持原样；",
    "- `npm run typecheck` 通过。",
    "",
    "> 这是在线预览中的模拟回复，不会连接真实的智能体或开发机。",
  ].join("\n");
  await streamText(run, "answer", answer, true);
  return answer;
}

function finish(run: Run, session: Session, status: Turn["status"], answer?: string) {
  const turn = run.turn;
  if (answer) {
    const reply: DemoMessage = { id: crypto.randomUUID(), session_id: session.id, role: "assistant", content: answer, created_at: timestamp() };
    db.messages.push(reply);
    turn.assistant_message_id = reply.id;
  }
  for (const item of turn.items) {
    if (item.tool && ["running", "waiting"].includes(item.tool.status || "")) item.tool.status = status;
  }
  Object.assign(turn, {
    status, paused_at: null, completed_at: timestamp(),
    duration_ms: Date.now() - Date.parse(turn.started_at) - (turn.paused_ms ?? 0),
  });
  runs.delete(session.id);
  publishTurn(run);
  setSlotBusy(session, false);
  publishSession(session.id, status === "completed" ? "idle" : status);
  if (answer) emit({ type: "message", sessionId: session.id, payload: { role: "assistant" } });
  emit({ type: "done", sessionId: session.id });
}

export function startRun(session: Session, content: string) {
  if (runs.has(session.id)) throw new Error("对话仍在运行，请等待结束或先停止。");
  const request: DemoMessage = { id: crypto.randomUUID(), session_id: session.id, role: "user", content, created_at: timestamp() };
  db.messages.push(request);
  const turn: Turn = {
    id: request.id, session_id: session.id, user_message_id: request.id, assistant_message_id: null,
    started_at: timestamp(), completed_at: null, duration_ms: null, paused_at: null, paused_ms: 0, status: "running", items: [],
  };
  db.turns.push(turn);
  const run: Run = { turn, stopped: false, paused: false };
  runs.set(session.id, run);
  setSlotBusy(session, true);
  publishSession(session.id, "running");
  emit({ type: "message", sessionId: session.id, payload: { role: "user" } });
  publishTurn(run);
  script(run, session, content).then(
    (answer) => finish(run, session, "completed", answer),
    (error: unknown) => finish(run, session, error instanceof Interrupted ? "interrupted" : "error"),
  );
}

export function controlRun(sessionId: string, action: "pause" | "resume" | "stop"): string {
  const run = runs.get(sessionId);
  if (!run) return findSession(sessionId)?.status || "idle";
  const turn = run.turn;
  if (action === "stop") {
    run.stopped = true;
    run.wake?.();
    run.interrupt?.();
    return "interrupted";
  }
  if (action === "pause" && !run.paused) {
    run.paused = true;
    Object.assign(turn, { status: "paused", paused_at: timestamp() });
  }
  if (action === "resume" && run.paused) {
    run.paused = false;
    turn.paused_ms = (turn.paused_ms ?? 0) + Date.now() - Date.parse(turn.paused_at || timestamp());
    Object.assign(turn, { status: "running", paused_at: null });
    run.wake?.();
  }
  publishTurn(run);
  publishSession(sessionId, turn.status);
  return turn.status;
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

export function decideApproval(id: string, allow: boolean, reason?: string): boolean {
  const resolve = approvalWaiters.get(id);
  resolve?.({ allow, reason });
  return !!resolve;
}

export function answerQuestion(id: string, answers: Record<string, string[]>): boolean {
  const resolve = questionWaiters.get(id);
  resolve?.(answers);
  return !!resolve;
}
