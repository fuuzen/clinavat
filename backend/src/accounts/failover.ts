import { randomUUID } from 'node:crypto';
import type { Context } from '../context.js';
import { projectFor, sessionFor } from '../context.js';
import { HttpError } from '../models.js';
import { validateAgentSelection } from '../agent/model-catalog.js';
import type { AgentContext, QuotaFailure } from '../agent/types.js';
import { slotForUser } from './access.js';

/** Runs after the old CLI and its lease have ended; the manager owns cancellation throughout this operation. */
export async function prepareSlotFailover(context: Context, previous: AgentContext, quota: QuotaFailure,
  excludedSlotIds: string[], signal: AbortSignal): Promise<AgentContext> {
  const { store, config, events, slots, turns } = context;
  signal.throwIfAborted();
  const session = sessionFor(context, previous.session.id, previous.user.id);
  if (session.slot_mode !== 'auto' || session.engine !== 'claude') throw new HttpError(409, '当前对话未启用 Claude 自动账号');
  if (config.credentials.isSessionBusy(session.id)) throw new HttpError(409, '原账号状态尚未回收，无法切换');
  const project = projectFor(context, session.project_id, previous.user.id);
  if (project.execution_mode === 'local' ? project.sync_status !== 'LOCAL' : project.sync_status !== 'WATCHING') {
    throw new HttpError(409, '项目同步不可用，已停止自动切换');
  }
  const candidates = await slots.candidates({ userId: session.user_id, engine: session.engine, model: session.model,
    exclude: excludedSlotIds, signal });
  let selectionError: unknown;
  for (const slot of candidates) {
    signal.throwIfAborted();
    const next: AgentContext = { user: { id: session.user_id }, project, slot, runtime_home: slot.home_dir,
      runtime_kind: 'conversation', session: { ...session } };
    try {
      await validateAgentSelection(config, next, { model: session.model, reasoningEffort: session.reasoning_effort });
    } catch (error) {
      if (signal.aborted || !(error instanceof HttpError) || error.statusCode !== 400) throw error;
      selectionError = error;
      continue;
    }
    signal.throwIfAborted();
    slotForUser(store, slot.id, session.user_id, session.engine);
    if (!slots.eligible(slot, session.user_id, session.model)) continue;
    const currentProject = projectFor(context, session.project_id, session.user_id);
    if (currentProject.execution_mode === 'local' ? currentProject.sync_status !== 'LOCAL' : currentProject.sync_status !== 'WATCHING') {
      throw new HttpError(409, '项目同步状态已变化，已停止自动切换');
    }
    const current = sessionFor(context, session.id, session.user_id);
    if (current.slot_mode !== 'auto' || current.slot_id !== session.slot_id) throw new HttpError(409, '对话账号设置已变化，已停止自动切换');
    const noteId = randomUUID();
    const window = quota.window === 'five_hour' ? '5 小时' : '每周';
    const note = `账号 ${previous.slot.id} 的${window}订阅额度已用尽，切换至 ${slot.id} 继续处理。先检查任务现状，避免重复操作。`;
    store.transaction(() => {
      store.run("UPDATE sessions SET slot_id=?,status='running',updated_at=datetime('now') WHERE id=?", slot.id, session.id);
      store.run("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'system',?)", noteId, session.id, note);
    });
    events.emit(session.user_id, { type: 'session', sessionId: session.id, payload: store.get('SELECT * FROM sessions WHERE id=?', session.id) });
    events.emit(session.user_id, { type: 'message', sessionId: session.id, payload: store.get('SELECT * FROM messages WHERE id=?', noteId) });
    const turn = turns.start(session.id, noteId, { slotId: slot.id, credentialRevision: slot.credential_revision }, randomUUID());
    return { ...next, project: currentProject, session: { ...current, turn_id: turn.id } };
  }
  throw selectionError ?? new HttpError(409, '没有支持当前模型和思考强度的可用账号');
}
