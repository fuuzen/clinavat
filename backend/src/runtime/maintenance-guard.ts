import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MaintenanceService } from './maintenance.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALWAYS_ALLOWED_PATHS = new Set(['/api/health', '/api/overview', '/api/events', '/api/site/settings']);
const TERMINAL_PATH = /^\/api\/projects\/[^/]+\/terminal$/;

// Running sessions must still be able to stop, cancel queued inputs, or answer in-flight approvals/questions.
const WRAP_UP_RULES: { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/api\/sessions\/[^/]+\/(stop|pause|cancel|interrupt)$/ },
  { method: 'DELETE', pattern: /^\/api\/sessions\/[^/]+\/queue\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/sessions\/[^/]+\/tasks\/[^/]+\/stop$/ },
  { method: 'POST', pattern: /^\/api\/sessions\/[^/]+\/agents\/stop$/ },
  { method: 'POST', pattern: /^\/api\/discussions\/[^/]+\/stop$/ },
  { method: 'POST', pattern: /^\/api\/approvals\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/sessions\/[^/]+\/questions\/[^/]+$/ },
];

function normalizedPath(url: string): string {
  const path = url.split('?')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function sendMaintenanceBlocked(reply: FastifyReply, maintenance: MaintenanceService): FastifyReply {
  const state = maintenance.getState();
  return reply.code(503).send({
    error: maintenance.blockMessage(state),
    code: 'MAINTENANCE_MODE',
    maintenance: state,
  });
}

function isAllowedDuringMaintenance(method: string, path: string): boolean {
  if (!path.startsWith('/api/')) return true;
  if (ALWAYS_ALLOWED_PATHS.has(path)) return true;
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return true;
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return true;
  if (TERMINAL_PATH.test(path)) return false;
  if (READ_METHODS.has(method)) return true;
  return WRAP_UP_RULES.some(rule => rule.method === method && rule.pattern.test(path));
}

export function registerMaintenanceGuard(app: FastifyInstance, maintenance: MaintenanceService): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!maintenance.isEnabled()) return;
    if (isAllowedDuringMaintenance(request.method.toUpperCase(), normalizedPath(request.url))) return;
    return sendMaintenanceBlocked(reply, maintenance);
  });
}
