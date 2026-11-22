import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionFor, type Context } from '../context.js';
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
  app.post('/api/sessions/:id/agents/deliver', async request => {
    const { id } = identifier.parse(request.params);
    sessionFor(context, id, request.user.id);
    z.object({}).strict().parse(request.body ?? {});
    await orchestrator.deliver(id);
    return orchestrator.view(id);
  });
}
