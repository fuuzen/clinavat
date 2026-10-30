import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectFor, sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError, type Session } from '../models.js';
import { slotForUser } from '../accounts/access.js';
import { accessCodexGoal, type CodexGoal } from '../agent/codex-goal.js';
import { validateAgentSelection } from '../agent/model-catalog.js';
import { validatePermissionMode } from '../agent/permissions.js';
import { validateSessionSettings } from '../agent/session-settings.js';
import type { AgentContext } from '../agent/types.js';

const identifier = z.object({ id: z.uuid() });
const objective = z.string().trim().min(1).max(4000);
const goalAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), objective }).strict(),
  z.object({ action: z.literal('edit'), objective }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
]);
type GoalAction = z.infer<typeof goalAction>;

function codexSession(context: Context, id: string, userId: string): Session {
  const session = sessionFor(context, id, userId);
  if (session.engine !== 'codex') throw new HttpError(400, 'Goal 模式仅支持 Codex');
  return session;
}

function goalContext(context: Context, session: Session): AgentContext {
  if (!session.slot_id) throw new HttpError(409, '请先为当前对话选择授权槽位');
  const slot = slotForUser(context.store, session.slot_id, session.user_id, 'codex');
  const project = projectFor(context, session.project_id, session.user_id);
  return { runtime_home: slot.home_dir, runtime_kind: 'conversation', user: { id: session.user_id },
    project, slot, session };
}

function requireIdle(context: Context, session: Session): void {
  if (context.agents.isBusy(session.id) || context.config.credentials.isSessionBusy(session.id)
    || ['running', 'waiting', 'pausing', 'paused'].includes(session.status)) {
    throw new HttpError(409, '当前对话仍在运行或回收状态，请稍后重试');
  }
}

async function accessIdleGoal(context: Context, session: Session, change?: { action: 'pause' | 'edit'; objective?: string }): Promise<CodexGoal | null> {
  requireIdle(context, session);
  if (!session.native_session_id) {
    if (change) throw new HttpError(409, '当前对话尚未设置 Goal');
    return null;
  }
  const runtime = goalContext(context, session);
  const release = await context.config.credentials.acquire(runtime);
  try { return await accessCodexGoal(context.config, runtime, change); }
  finally { await release(); }
}

async function startGoal(context: Context, session: Session, action: Extract<GoalAction, { action: 'create' | 'resume' }>): Promise<CodexGoal | null> {
  const { agents, config, store, events, turns, workspaces } = context;
  requireIdle(context, session);
  const runtime = goalContext(context, session);
  const project = projectFor(context, session.project_id, session.user_id);
  const { slot } = runtime;
  if (project.execution_mode === 'local' ? project.sync_status !== 'LOCAL' : project.sync_status !== 'WATCHING') {
    throw new HttpError(409, project.execution_mode === 'local' ? '请先检查本机项目目录是否可访问' : '请先恢复项目同步');
  }
  const { agentMode, rolePreset } = validateSessionSettings('codex', session.agent_mode, session.role_preset);
  if (agentMode === 'plan') throw new HttpError(409, '请先切换到 Normal 模式，再启动 Goal');
  runtime.session = { ...runtime.session,
    permission_mode: validatePermissionMode('codex', session.permission_mode),
    agent_mode: agentMode, role_preset: rolePreset, goal: action };
  const release = await config.credentials.acquire(runtime);
  try {
    const existingGoal = session.native_session_id ? await accessCodexGoal(config, runtime) : null;
    if (action.action === 'resume' && !existingGoal) throw new HttpError(409, '当前对话尚未设置 Goal');
    if (action.action === 'create' && existingGoal) throw new HttpError(409, '当前目标已存在，请使用 /goal edit 修改');
    await validateAgentSelection(config, runtime, { model: session.model, reasoningEffort: session.reasoning_effort });
    try { await workspaces.flush(project); }
    catch (error) {
      store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
      events.emit(session.user_id, { type: 'project', payload: { id: project.id, sync_status: 'ERROR' } });
      throw error;
    }
    const turnId = randomUUID();
    const messageId = action.action === 'create' ? turnId : store.get<{ id: string }>(
      "SELECT id FROM messages WHERE session_id=? AND role='user' ORDER BY rowid DESC LIMIT 1", session.id)?.id;
    if (!messageId) throw new HttpError(409, '请先开始一次对话，再恢复 Goal');
    store.transaction(() => {
      if (action.action === 'create') store.run("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'user',?)", messageId, session.id, action.objective);
      store.run("UPDATE sessions SET status='running',updated_at=datetime('now') WHERE id=?", session.id);
    });
    turns.start(session.id, messageId, { slotId: slot.id, credentialRevision: slot.credential_revision }, turnId);
    if (action.action === 'create') events.emit(session.user_id, { type: 'message', sessionId: session.id,
      payload: store.get('SELECT * FROM messages WHERE id=?', messageId) });
    try {
      await agents.start({ ...runtime, session: { ...runtime.session, turn_id: turnId } }, '');
    } catch (error) {
      turns.finish(session.id, 'error', turnId);
      store.run("UPDATE sessions SET status='error',updated_at=datetime('now') WHERE id=?", session.id);
      throw error;
    }
    // A very short native run may already have finished before its HTTP response is read.
    if (agents.isBusy(session.id)) {
      try { return await agents.getGoal(session.id); }
      catch { /* Completion may already be closing the live connection; read saved metadata below. */ }
    }
    const current = sessionFor(context, session.id, session.user_id);
    return accessCodexGoal(config, { ...runtime, session: { ...runtime.session, native_session_id: current.native_session_id } });
  } finally { await release(); }
}

export function sessionGoalRoutes(app: FastifyInstance, context: Context): void {
  app.get('/api/sessions/:id/goal', async request => {
    const { id } = identifier.parse(request.params);
    const session = codexSession(context, id, request.user.id);
    if (context.agents.isBusy(id)) return { goal: await context.agents.getGoal(id) };
    return withResourceLocks(context, [`session:${id}`], async () => ({
      goal: await accessIdleGoal(context, codexSession(context, id, request.user.id)),
    }), [`project:${session.project_id}`]);
  });
  app.post('/api/sessions/:id/goal', async request => {
    const { id } = identifier.parse(request.params);
    const input = goalAction.parse(request.body);
    const original = codexSession(context, id, request.user.id);
    try {
      return await withResourceLocks(context, [`goal:${id}`], async () => {
        const session = codexSession(context, id, request.user.id);
        let goal: CodexGoal | null;
        if (context.agents.isBusy(id)) {
          if (input.action === 'create') throw new HttpError(409, '请等待当前执行结束，再设置新目标');
          goal = await context.agents.changeGoal(id, input);
        } else {
          goal = await withResourceLocks(context, [`session:${id}`], async () => {
            if (input.action === 'create' || input.action === 'resume') return startGoal(context, session, input);
            const saved = await accessIdleGoal(context, session, input);
            context.events.emit(request.user.id, { type: 'goal', sessionId: id, payload: { goal: saved } });
            return saved;
          });
        }
        return { goal };
      }, [`project:${original.project_id}`]);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, error instanceof Error ? error.message : 'Goal 操作失败');
    }
  });
}
