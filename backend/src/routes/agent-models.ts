import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectFor, type Context } from '../context.js';
import { loadAgentModels } from '../agent/model-catalog.js';
import { HttpError } from '../models.js';

export function agentModelRoutes(app: FastifyInstance, context: Context) {
  app.get('/api/agent/models', async request => {
    const { engine, projectId } = z.object({ engine: z.enum(['claude', 'codex']), projectId: z.uuid() }).parse(request.query);
    const project = projectFor(context, projectId, request.user.id);
    const slot = context.store.assignSlot(request.user.id);
    if (!slot || slot.status !== 'ASSIGNED') throw new HttpError(409, '尚无可用的专属账号');
    const cliTypes = JSON.parse(slot.cli_types) as string[];
    if (!cliTypes.includes(engine)) throw new HttpError(409, '该槽位未启用当前 CLI');
    try {
      const models = await loadAgentModels(context.config, {
        user: request.user, project, slot: { ...slot, cli_types: cliTypes }, session: { id: '', engine },
      });
      return { models };
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : '模型目录读取失败');
    }
  });
}
