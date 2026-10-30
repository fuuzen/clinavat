import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import type { GatewayService, GatewayState } from '../gateway/service.js';

// Shape checks only; the gateway enforces the egress invariants itself.
const tag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const force = z.boolean().default(false);
const node = z.record(z.string(), z.unknown()).refine(value => typeof value.tag === 'string' && typeof value.type === 'string', '节点需包含 tag 与 type');
const mutation = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

export function gatewayRoutes(app: FastifyInstance, gateway: GatewayService) {
  const change = (op: string, schema: { parse(value: unknown): Record<string, unknown> & { force: boolean } }) =>
    async (request: FastifyRequest) => {
      requireAdmin(request);
      const { force: allowInterrupt, ...args } = schema.parse(request.body);
      return gateway.mutate(request.user.id, op, args, allowInterrupt);
    };

  app.get('/api/admin/gateway', async request => {
    requireAdmin(request);
    return gateway.info();
  });
  app.get('/api/admin/gateway/overview', async request => {
    requireAdmin(request);
    return gateway.overview();
  });
  app.get('/api/admin/gateway/dev-hosts', async request => {
    requireAdmin(request);
    const { state, infra } = await gateway.client.call<{ state: GatewayState; infra: { lan_direct: string[] } }>('state.get');
    return gateway.devHosts(state.dev_direct, infra.lan_direct);
  });
  app.post('/api/admin/gateway/delay', mutation, async request => {
    requireAdmin(request);
    return gateway.read('nodes.delay');
  });
  app.get('/api/admin/gateway/connections', async request => {
    requireAdmin(request);
    return gateway.read('connections');
  });
  app.put('/api/admin/gateway/nodes', mutation, change('nodes.put',
    z.object({ nodes: z.array(node).min(1).max(64), force }).strict()));
  app.post('/api/admin/gateway/select', mutation, change('selector.select', z.object({ tag, force }).strict()));
  app.put('/api/admin/gateway/rules', mutation, change('rules.put',
    z.object({ rules: z.array(z.record(z.string(), z.unknown())).max(200), force }).strict()));
  app.put('/api/admin/gateway/dev-direct', mutation, change('dev_direct.put',
    z.object({ dev_direct: z.array(z.string().max(43)).max(64), force }).strict()));
  app.put('/api/admin/gateway/forwards', mutation, change('forwards.put', z.object({
    forwards: z.array(z.object({
      proto: z.enum(['tcp', 'udp']), port: z.number().int(), to_port: z.number().int(), note: z.string().max(80).optional(),
    }).strict()).max(32), force,
  }).strict()));
  app.put('/api/admin/gateway/sites', mutation, change('sites.put',
    z.object({ sites: z.array(z.string().max(253)).max(16), force }).strict()));
  app.post('/api/admin/gateway/certs', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    change('cert.issue', z.object({ domain: z.string().max(253), force }).strict()));
  app.post('/api/admin/gateway/rollback', mutation, change('rollback',
    z.object({ revision: z.number().int().positive(), force }).strict()));
}
