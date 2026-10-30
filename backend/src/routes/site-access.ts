import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { publicUrlsSchema, type SiteAccess } from '../site-access.js';

export function siteAccessRoutes(app: FastifyInstance, siteAccess: SiteAccess) {
  app.get('/api/admin/site-access', async request => {
    requireAdmin(request);
    return siteAccess.view();
  });
  app.patch('/api/admin/site-access', async request => {
    requireAdmin(request);
    const input = z.object({
      publicUrls: publicUrlsSchema,
      expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
    }).strict().parse(request.body);
    return siteAccess.update(input.publicUrls, input.expectedRevision);
  });
}
