import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { withResourceLocks, type Context } from '../context.js';
import type { GatewayService, GatewayState } from '../gateway/service.js';
import { nodeLocation } from '../gateway/location.js';
import { defaultTimezone, normalizeTimezone, supportedTimezones } from '../execution/timezones.js';
import { HttpError, type Slot } from '../models.js';

// Shape checks only; the gateway enforces the egress invariants itself.
const tag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const force = z.boolean().default(false);
const node = z.record(z.string(), z.unknown()).refine(value => typeof value.tag === 'string' && typeof value.type === 'string', '节点需包含 tag 与 type');
const preproxy = z.object({
  nodes: z.array(node).max(64),
  groups: z.array(z.object({
    tag, nodes: z.array(tag).min(1).max(64), url: z.string().url().max(2048).optional(),
    interval: z.string().max(32).optional(), tolerance: z.number().int().min(0).max(10000).optional(),
  }).strict()).max(16),
  routes: z.record(tag, z.union([tag, z.array(tag).min(1).max(8)])),
}).strict();
const mutation = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

export function gatewayRoutes(app: FastifyInstance, gateway: GatewayService, context: Context) {
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
  app.get('/api/admin/gateway/timezones', async request => {
    requireAdmin(request);
    const timezone = defaultTimezone();
    return { timezones: [...new Set([...supportedTimezones(), timezone])].sort(), defaultTimezone: timezone };
  });
  app.post('/api/admin/gateway/nodes/:tag/location', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    requireAdmin(request);
    const input = z.object({ tag }).parse(request.params);
    return nodeLocation(gateway.client, input.tag);
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
  app.post('/api/admin/gateway/preproxy/delay', mutation, async request => {
    requireAdmin(request);
    return gateway.read('preproxy.delay');
  });
  app.put('/api/admin/gateway/proxies', mutation, change('proxies.put',
    z.object({ nodes: z.array(node).min(1).max(64), preproxy,
      expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), force }).strict()));
  app.put('/api/admin/gateway/preproxy', mutation, change('preproxy.put',
    z.object({ preproxy, force }).strict()));
  app.get('/api/admin/gateway/connections', async request => {
    requireAdmin(request);
    return gateway.read('connections');
  });
  app.put('/api/admin/gateway/nodes', mutation, change('nodes.put',
    z.object({ nodes: z.array(node).min(1).max(64), force }).strict()));
  app.post('/api/admin/gateway/select', mutation, change('selector.select', z.object({ tag, force }).strict()));
  app.put('/api/admin/gateway/bindings/:address', mutation, async request => {
    requireAdmin(request);
    const { address } = z.object({ address: z.ipv4() }).parse(request.params);
    const { force: _force, ...input } = z.object({
      node: tag.nullable(), label: z.string().max(80).optional(), interrupt: z.boolean().default(false), force,
      timezone: z.string().trim().min(1).max(100).nullable().optional(),
    }).strict().parse(request.body);
    if (typeof input.timezone === 'string') input.timezone = normalizeTimezone(input.timezone);
    if (input.timezone === undefined) return gateway.setBinding(request.user.id, address, input);
    const slot = gateway.slotAt(address);
    return withResourceLocks(context, [`slot-config:${slot.id}`], async () => {
      if (input.timezone === gateway.slotAt(address).timezone) return gateway.setBinding(request.user.id, address, input);
      await context.agents.reclaimWhere({ slotId: slot.id });
      const saved = await context.config.credentials.whileIdle(slot.id, async () => {
        const current = context.store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slot.id);
        if (!current) throw new HttpError(404, '槽位不存在');
        try { await context.config.execution.assertReleased(current.home_dir); }
        catch (error) { throw new HttpError(409, `无法修改槽位时区：${error instanceof Error ? error.message : String(error)}`); }
        return gateway.setBinding(request.user.id, address, input);
      });
      if (!saved) throw new HttpError(409, '该槽位正在使用或查询额度，请结束后再修改时区');
      return saved.value;
    });
  });
  app.post('/api/admin/gateway/source-policy', mutation, change('source_policy.set',
    z.object({ source_policy: z.enum(['shared', 'bound']), force }).strict()));
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
