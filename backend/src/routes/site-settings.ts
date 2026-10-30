import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth.js';
import type { Store } from '../database.js';
import type { EventBus } from '../events.js';
import { siteSettingsSchema, type SiteSettingsService } from '../site-settings.js';

export function siteSettingsRoutes(app: FastifyInstance, settings: SiteSettingsService, store: Store, events: EventBus) {
  app.get('/api/site/settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return settings.view();
  });
  app.get('/api/admin/site/settings', async (request, reply) => {
    requireAdmin(request);
    reply.header('Cache-Control', 'no-store');
    return settings.view();
  });
  app.put('/api/admin/site/settings', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    requireAdmin(request);
    const input = siteSettingsSchema.parse(request.body);
    reply.header('Cache-Control', 'no-store');
    const saved = settings.update(input);
    for (const user of store.all<{ id: string }>('SELECT id FROM users')) {
      events.broadcast(user.id, { type: 'site-settings', payload: {} });
    }
    return saved;
  });
}
