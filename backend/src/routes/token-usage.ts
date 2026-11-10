import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import type { Context } from '../context.js';
import { priceSnapshotDate } from '../token-usage/model-prices.js';

const period = z.object({ days: z.coerce.number().int().min(0).max(3650).default(30) }).strict();

// Zero days means all recorded usage; timestamps follow SQLite's UTC `datetime('now')` format.
function since(days: number): string | null {
  return days ? new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19) : null;
}

export function tokenUsageRoutes(app: FastifyInstance, context: Context) {
  app.get('/api/token-usage', async request => {
    const { days } = period.parse(request.query);
    return { days, priceSnapshotDate, rows: context.tokenUsage.report(since(days), request.user.id) };
  });
  app.get('/api/admin/token-usage', async request => {
    requireAdmin(request);
    const { days } = period.parse(request.query);
    return { days, priceSnapshotDate, rows: context.tokenUsage.report(since(days)) };
  });
}
