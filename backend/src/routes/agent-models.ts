import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectFor, sessionFor, withResourceLocks, type Context } from '../context.js';
import { loadAgentModels } from '../agent/model-catalog.js';
import { HttpError } from '../models.js';
import { slotForUser } from '../accounts/access.js';
import { selectedSlotId } from './session-messages.js';

export function agentModelRoutes(app: FastifyInstance, context: Context) {
  app.get('/api/agent/models', async request => {
    const { engine, projectId, slotId, sessionId } = z.object({
      engine: z.enum(['claude', 'codex']), projectId: z.uuid(), slotId: selectedSlotId, sessionId: z.uuid().optional(),
    }).parse(request.query);
    return withResourceLocks(context, [], async () => {
      const project = projectFor(context, projectId, request.user.id);
      if (sessionId) {
        const session = sessionFor(context, sessionId, request.user.id);
        if (session.project_id !== projectId || session.engine !== engine) throw new HttpError(400, '对话与所选项目或引擎不匹配');
      }
      const slot = slotForUser(context.store, slotId, request.user.id, engine);
      try {
        const models = await loadAgentModels(context.config, {
          runtime_home: slot.home_dir, runtime_kind: 'probe',
          user: request.user, project, slot, session: { id: '', engine },
        });
        return { models };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, error instanceof Error ? error.message : '模型目录读取失败');
      }
    }, [`project:${projectId}`]);
  });
}
