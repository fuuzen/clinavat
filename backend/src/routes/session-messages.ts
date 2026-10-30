import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectFor, sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError } from '../models.js';
import { validateAgentSelection } from '../agent/model-catalog.js';
import { permissionModes, validatePermissionMode } from '../agent/permissions.js';
import { slotForUser } from '../accounts/access.js';
import { agentModes, rolePresets, validateSessionSettings } from '../agent/session-settings.js';
import { expandProjectReferences } from '../runtime/project-references.js';

export const selectedSlotId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const selectionFields = {
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoningEffort: z.string().trim().min(1).max(32).nullable().optional(),
  permissionMode: z.enum(permissionModes).optional(),
  agentMode: z.enum(agentModes).optional(),
  rolePreset: z.enum(rolePresets).optional(),
};

export function sessionMessageRoutes(app: FastifyInstance, context: Context) {
  const { store, events, agents, workspaces, turns, config } = context;
  app.post('/api/sessions/:id/messages', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const input = z.object({ content: z.string().trim().min(1).max(100000), slotId: selectedSlotId.optional(), ...selectionFields }).parse(request.body);
    const original = sessionFor(context, id, request.user.id);
    return withResourceLocks(context, [`session:${id}`], async () => {
      const session = sessionFor(context, id, request.user.id);
      const project = projectFor(context, session.project_id, request.user.id);
      if (agents.isBusy(id) || ['running', 'waiting', 'pausing', 'paused'].includes(session.status) || config.credentials.isSessionBusy(id)) {
        throw new HttpError(409, '当前对话仍在运行或回收状态，请等待结束或先停止');
      }
      const slotId = input.slotId ?? session.slot_id;
      if (!slotId) throw new HttpError(409, '请先为当前对话选择授权槽位');
      const slot = slotForUser(store, slotId, request.user.id, session.engine);
      if (project.execution_mode === 'local' ? project.sync_status !== 'LOCAL' : project.sync_status !== 'WATCHING') {
        throw new HttpError(409, project.execution_mode === 'local' ? '请先检查本机项目目录是否可访问' : '请先恢复项目同步');
      }
      const changedSlot = slot.id !== session.slot_id;
      const model = input.model === undefined ? changedSlot ? null : session.model : input.model;
      const reasoningEffort = input.reasoningEffort === undefined ? changedSlot ? null : session.reasoning_effort : input.reasoningEffort;
      const permissionMode = validatePermissionMode(session.engine, input.permissionMode ?? session.permission_mode);
      const { agentMode, rolePreset } = validateSessionSettings(session.engine,
        input.agentMode ?? session.agent_mode ?? 'normal', input.rolePreset ?? session.role_preset ?? 'default');
      const compact = /^\/compact(?:\s|$)/i.test(input.content);
      if (compact) input.content = input.content.replace(/^\/compact/i, '/compact');
      if (/^\/[a-z][\w-]*(?:\s|$)/i.test(input.content) && !compact) {
        throw new HttpError(400, '当前网页端不支持这个命令，请输入 / 查看可用命令');
      }
      if (compact && !session.native_session_id) throw new HttpError(409, '请先开始一次对话，再压缩原生上下文');
      if (compact && session.engine === 'codex' && input.content !== '/compact') {
        throw new HttpError(400, 'Codex 的 /compact 暂不接受附加参数');
      }
      const runContext = {
        runtime_home: slot.home_dir,
        runtime_kind: 'conversation' as const,
        user: request.user, project, slot,
        session: { ...session, slot_id: slot.id, model, reasoning_effort: reasoningEffort, permission_mode: permissionMode,
          agent_mode: agentMode, role_preset: rolePreset, ...(compact ? { command: 'compact' as const } : {}) },
      };
      // Reserve before persisting a turn, including model validation and workspace preparation.
      const release = await config.credentials.acquire(runContext);
      try {
        await validateAgentSelection(config, runContext, { model, reasoningEffort });
        try { await workspaces.flush(project); }
        catch (error) {
          store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
          events.emit(request.user.id, { type: 'project', payload: { id: project.id, sync_status: 'ERROR' } });
          throw error;
        }
        const expandedContent = compact ? input.content : await expandProjectReferences(workspaces, project, input.content);
        const messageId = randomUUID();
        store.transaction(() => {
          store.run(`UPDATE sessions SET slot_id=?,model=?,reasoning_effort=?,permission_mode=?,agent_mode=?,role_preset=?,status='running',updated_at=datetime('now') WHERE id=?`,
            slot.id, model, reasoningEffort, permissionMode, agentMode, rolePreset, id);
          store.run("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'user',?)", messageId, id, input.content);
        });
        turns.start(id, messageId, { slotId: slot.id, credentialRevision: slot.credential_revision });
        events.emit(request.user.id, { type: 'message', sessionId: id, payload: store.get('SELECT * FROM messages WHERE id=?', messageId) });
        try {
          const previousMessages = !session.native_session_id
            ? store.all<{ role: string; content: string }>('SELECT role,substr(content,1,2000) AS content FROM (SELECT rowid,role,content FROM messages WHERE session_id=? AND id<>? ORDER BY rowid DESC LIMIT 12) ORDER BY rowid', id, messageId)
            : [];
          const prompt = previousMessages.length && !expandedContent.startsWith('/')
            ? `The native session was restarted. The following is saved conversation history for context; file paths may refer to the former workspace location. Use the current project working directory.\n<previous_conversation>\n${JSON.stringify(previousMessages)}\n</previous_conversation>\n\nCurrent user request:\n${expandedContent}`
            : expandedContent;
          await agents.start({ ...runContext, session: { ...runContext.session, turn_id: messageId } }, prompt);
          return { sessionId: id, status: 'running' };
        } catch (error) {
          turns.finish(id, 'error');
          store.run("UPDATE sessions SET status='error',updated_at=datetime('now') WHERE id=?", id);
          const message = error instanceof Error ? error.message : String(error);
          events.emit(request.user.id, { type: 'error', sessionId: id, payload: { message } });
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, message);
        }
      } finally { await release(); }
    }, [`project:${original.project_id}`]);
  });
}
