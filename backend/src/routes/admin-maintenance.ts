import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import type { Context } from '../context.js';

const maintenanceInput = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).nullable().optional(),
}).strict();

export function adminMaintenanceRoutes(app: FastifyInstance, context: Context): void {
  const { maintenance } = context;

  app.get('/api/admin/maintenance', async request => {
    requireAdmin(request);
    return {
      maintenance: maintenance.getState(),
      activity: maintenance.getActivity(),
    };
  });

  app.post('/api/admin/maintenance', async request => {
    requireAdmin(request);
    const input = maintenanceInput.parse(request.body);
    const { state, reclaimedIdle } = maintenance.setEnabled(input.enabled, request.user.id, input.message);
    request.log.info({ enabled: state.enabled, reclaimedIdle, userId: request.user.id }, 'maintenance mode updated');
    return {
      maintenance: state,
      activity: maintenance.getActivity(),
      reclaimedIdle,
    };
  });

  app.post('/api/admin/maintenance/reclaim-idle', async request => {
    requireAdmin(request);
    z.object({}).strict().parse(request.body ?? {});
    const reclaimedIdle = maintenance.reclaimIdle();
    request.log.info({ reclaimedIdle, userId: request.user.id }, 'idle resident CLIs reclaimed');
    return {
      reclaimedIdle,
      maintenance: maintenance.getState(),
      activity: maintenance.getActivity(),
    };
  });
}
