import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { loadAgentModels } from '../agent/model-catalog.js';
import { HttpError } from '../models.js';
import { slotForUser } from '../accounts/access.js';
import { selectedSlotId } from './session-messages.js';

export function agentModelRoutes(app: FastifyInstance, context: Context) {
  app.get('/api/agent/models', async request => {
    const { engine, slotId } = z.object({ engine: z.enum(['claude', 'codex']), slotId: selectedSlotId }).parse(request.query);
    const slot = slotForUser(context.store, slotId, request.user.id, engine);
    try {
      return { models: await loadAgentModels(context.config, { user: request.user, slot, session: { engine } }) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, error instanceof Error ? error.message : '模型目录读取失败');
    }
  });
}
