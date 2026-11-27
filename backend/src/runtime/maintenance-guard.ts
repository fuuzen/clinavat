import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MaintenanceService } from './maintenance.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED_READ_ROUTES = new Set(['/api/projects/:id/terminal', '/api/client-devices/tunnel']);

// Running sessions must still be able to stop, pause/resume, cancel queued inputs, or answer in-flight approvals/questions.
const WRAP_UP_ROUTES = new Set([
  'POST /api/sessions/:id/stop',
  'POST /api/sessions/:id/pause',
  'POST /api/sessions/:id/resume',
  'DELETE /api/sessions/:id/queue/:inputId',
  'POST /api/sessions/:id/tasks/:taskId/stop',
  'POST /api/sessions/:id/agents/stop',
  'POST /api/discussions/:id/stop',
  'POST /api/approvals/:id',
  'POST /api/sessions/:id/questions/:requestId',
  'POST /api/sessions/:id/btw/:btwId/cancel',
]);

export function sendMaintenanceBlocked(reply: FastifyReply, maintenance: MaintenanceService): FastifyReply {
  const state = maintenance.getState();
  return reply.code(503).send({
    error: maintenance.blockMessage(state),
    code: 'MAINTENANCE_MODE',
    maintenance: state,
  });
}

function isAllowedDuringMaintenance(method: string, routeUrl: string | undefined): boolean {
  // Unmatched routes have no canonical pattern; reject non-safe methods so encoded or unknown paths cannot slip through.
  if (!routeUrl) return READ_METHODS.has(method);
  if (routeUrl === '/api/auth' || routeUrl.startsWith('/api/auth/')) return true;
  if (routeUrl === '/api/admin' || routeUrl.startsWith('/api/admin/')) return true;
  if (routeUrl === '/api/client-devices/bootstrap') return true;
  if (BLOCKED_READ_ROUTES.has(routeUrl)) return false;
  if (READ_METHODS.has(method)) return true;
  return WRAP_UP_ROUTES.has(`${method} ${routeUrl}`);
}

export function registerMaintenanceGuard(app: FastifyInstance, maintenance: MaintenanceService): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!maintenance.isEnabled()) return;
    if (isAllowedDuringMaintenance(request.method.toUpperCase(), request.routeOptions?.url)) return;
    return sendMaintenanceBlocked(reply, maintenance);
  });
}
