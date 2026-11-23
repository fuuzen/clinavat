import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectFor, sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError } from '../models.js';
import type { Orchestrator } from '../orchestration/service.js';
import { toolInputs } from '../orchestration/tools.js';
import { slotChoice } from '../orchestration/children.js';
import { agentEngines } from '../agent/engines.js';
import { createSession, sessionInput } from './sessions.js';
import { profileInput } from '../orchestration/roster.js';
import { memoryKeySchema } from '../orchestration/memory.js';

const discussionInput = toolInputs.start_discussion.extend({
  // Synthesizes the record at the end, in a new conversation that hosts the discussion.
  moderator: z.object({ engine: z.enum(agentEngines), slotId: z.string().trim().min(1).max(64).optional(),
    model: z.string().trim().min(1).max(200).optional(), reasoningEffort: z.string().trim().min(1).max(32).optional() }),
}).strict();

const identifier = z.object({ id: z.uuid() });

/** The agent panel of a master conversation: its children, their reports, and stopping them all. */
export function sessionAgentRoutes(app: FastifyInstance, context: Context, orchestrator: Orchestrator) {
  app.get('/api/sessions/:id/agents', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    return orchestrator.view(id);
  });
  app.post('/api/sessions/:id/agents/stop', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    z.object({}).strict().parse(request.body ?? {});
    await orchestrator.stopAll(request.user.id, id);
    return { ok: true };
  });
  // The user's own decisions about a child's worktree branch; they need no approval.
  const child = z.object({ id: z.uuid(), childId: z.uuid() });
  app.post('/api/sessions/:id/agents/:childId/merge', async request => {
    const { id, childId } = child.parse(request.params);
    const input = z.object({ mode: z.enum(['merge', 'squash']).default('merge'), onConflict: z.enum(['abort', 'leave']).default('abort') })
      .strict().parse(request.body ?? {});
    const master = sessionFor(context, id, request.user.id);
    const target = sessionFor(context, childId, request.user.id);
    if (target.parent_session_id !== master.id) throw new HttpError(404, '子智能体不属于该对话');
    return withResourceLocks(context, [`session:${childId}`], () => orchestrator.merge(target, input.mode, input.onConflict));
  });
  app.post('/api/sessions/:id/agents/:childId/discard', async request => {
    const { id, childId } = child.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await withResourceLocks(context, [`session:${childId}`], () => orchestrator.discard(request.user, id, childId));
    return orchestrator.view(id);
  });
  app.post('/api/sessions/:id/agents/:childId/handoff', async request => {
    const { id, childId } = child.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await orchestrator.handoff(request.user, id, childId);
    return { ok: true };
  });
  app.post('/api/projects/:id/discussions', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    const { moderator, ...input } = discussionInput.parse(request.body);
    const project = projectFor(context, id, request.user.id);
    if (project.parent_project_id) throw new HttpError(400, '请在主项目中发起讨论');
    const host = await createSession(context, request.user, sessionInput.parse({
      projectId: id, engine: moderator.engine, ...slotChoice(context, request.user, moderator.engine, moderator.slotId, moderator.model),
      title: `讨论：${input.topic.replace(/\s+/g, ' ').slice(0, 40)}`, model: moderator.model, reasoningEffort: moderator.reasoningEffort,
    }));
    try {
      const { id: discussionId } = await orchestrator.startDiscussion(request.user, host, input);
      return reply.code(201).send({ sessionId: host.id, discussionId });
    } catch (error) {
      context.store.run('DELETE FROM sessions WHERE id=?', host.id);
      context.events.emit(request.user.id, { type: 'session', sessionId: host.id, payload: { id: host.id, deleted: true } });
      throw error;
    }
  });
  app.post('/api/discussions/:id/stop', async request => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await orchestrator.stopDiscussion(request.user, id);
    return { ok: true };
  });
  // Other pages learn of a changed roster through the event and read it again with the overview.
  const rosterChanged = (userId: string) => context.events.emit(userId, { type: 'agent-profiles', payload: {} });
  app.get('/api/agent-profiles', async request => orchestrator.roster.list(request.user.id));
  app.post('/api/agent-profiles', async (request, reply) => {
    const saved = orchestrator.roster.save(request.user.id, profileInput.parse(request.body));
    rosterChanged(request.user.id);
    return reply.code(201).send(saved);
  });
  app.put('/api/agent-profiles/:id', async request => {
    const { id } = identifier.parse(request.params);
    const saved = orchestrator.roster.save(request.user.id, profileInput.parse(request.body), id);
    rosterChanged(request.user.id);
    return saved;
  });
  app.delete('/api/agent-profiles/:id', async request => {
    const { id } = identifier.parse(request.params);
    orchestrator.roster.remove(request.user.id, id);
    rosterChanged(request.user.id);
    return { ok: true };
  });
  app.post('/api/sessions/:id/agents/deliver', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    z.object({}).strict().parse(request.body ?? {});
    await orchestrator.deliver(id);
    return orchestrator.view(id);
  });
  app.delete('/api/sessions/:id/agents/memories/:key', async request => {
    const { id, key } = z.object({ id: z.uuid(), key: memoryKeySchema }).parse(request.params);
    const master = sessionFor(context, id, request.user.id);
    orchestrator.memory.remove(master.project_id, key);
    orchestrator.publish(id);
    return orchestrator.view(id);
  });
}
