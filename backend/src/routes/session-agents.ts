import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError } from '../models.js';
import type { Orchestrator } from '../orchestration/service.js';

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
  app.post('/api/sessions/:id/agents/deliver', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    z.object({}).strict().parse(request.body ?? {});
    await orchestrator.deliver(id);
    return orchestrator.view(id);
  });
}
