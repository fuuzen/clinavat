import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import type { Context } from '../context.js';

const period = z.object({ days: z.coerce.number().int().min(0).max(3650).default(30) }).strict();
const perMillion = z.number().finite().min(0).max(100_000);
const override = z.object({
  model: z.string().trim().min(1).max(200), input: perMillion, cacheRead: perMillion.nullable(),
  cacheWrite: perMillion.nullable(), output: perMillion,
}).strict();

// Zero days means all recorded usage; timestamps follow SQLite's UTC `datetime('now')` format.
function since(days: number): string | null {
  return days ? new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19) : null;
}

export function tokenUsageRoutes(app: FastifyInstance, context: Context) {
  const { tokenUsage, prices } = context;
  app.get('/api/token-usage', async request => {
    const { days } = period.parse(request.query);
    return { days, priceSnapshotDate: prices.info().date, rows: tokenUsage.report(since(days), request.user.id) };
  });
  app.get('/api/admin/token-usage', async request => {
    requireAdmin(request);
    const { days } = period.parse(request.query);
    return { days, priceSnapshotDate: prices.info().date, rows: tokenUsage.report(since(days)) };
  });
  const priceList = () => ({ snapshot: prices.info(), entries: prices.entries(), unpricedModels: tokenUsage.unpricedModels() });
  app.get('/api/admin/model-prices', async request => {
    requireAdmin(request);
    return priceList();
  });
  // LiteLLM's price list format; the page sends only OpenAI, Anthropic, and Gemini entries to stay within request limits.
  app.put('/api/admin/model-prices/snapshot', async request => {
    requireAdmin(request);
    prices.importLiteLLM(request.body);
    return priceList();
  });
  app.delete('/api/admin/model-prices/snapshot', async request => {
    requireAdmin(request);
    prices.restoreBundled();
    return priceList();
  });
  app.put('/api/admin/model-prices/overrides', async request => {
    requireAdmin(request);
    const input = override.parse(request.body);
    prices.setOverride(input.model, [input.input, input.cacheRead, input.cacheWrite, input.output]);
    return priceList();
  });
  app.delete('/api/admin/model-prices/overrides', async request => {
    requireAdmin(request);
    const { model } = z.object({ model: z.string().trim().min(1).max(200) }).strict().parse(request.query);
    prices.setOverride(model, null);
    return priceList();
  });
}
