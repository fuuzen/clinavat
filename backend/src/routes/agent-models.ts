import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { loadModelCatalog, refreshModelCatalog } from '../agent/model-catalog.js';
import { HttpError, type Slot } from '../models.js';
import { slotForUser } from '../accounts/access.js';
import { announceSlotChange } from '../accounts/assignments.js';
import { selectedSlotId } from './session-messages.js';
import { agentPreferenceSchema, userModels } from '../agent-defaults.js';
import { agentEngines } from '../agent/engines.js';

const catalogError = (error: unknown) => error instanceof HttpError ? error
  : new HttpError(502, error instanceof Error ? error.message : '模型目录读取失败');

export function agentModelRoutes(app: FastifyInstance, context: Context) {
  const { store, config, agentDefaults, events } = context;
  const engine = z.enum(agentEngines);
  // Only saved catalogs are offered, so opening the settings never starts a CLI.
  const settingsView = (userId: string) => ({
    defaults: agentDefaults.user(userId),
    catalogs: Object.fromEntries(agentEngines.map(name => [name, userModels(store, userId, name)])),
  });
  app.get('/api/settings/agent', async request => settingsView(request.user.id));
  app.put('/api/settings/agent/:engine', async request => {
    const params = z.object({ engine }).parse(request.params);
    agentDefaults.update(request.user.id, params.engine, agentPreferenceSchema.parse(request.body));
    events.broadcast(request.user.id, { type: 'agent-defaults', payload: {} });
    return settingsView(request.user.id);
  });
  app.get('/api/agent/models', async request => {
    const query = z.object({ engine, slotId: selectedSlotId }).parse(request.query);
    const slot = slotForUser(store, query.slotId, request.user.id, query.engine);
    if (context.maintenance.isEnabled()) {
      return config.catalogs.read(slot.id) ?? { models: [], refreshedAt: '' };
    }
    try { return await loadModelCatalog(config, { user: request.user, slot, session: { engine: query.engine } }); }
    catch (error) { throw catalogError(error); }
  });
  // The slot's users and administrators decide when its CLI is asked for the catalog again.
  app.post('/api/slots/:id/models/refresh', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const { id } = z.object({ id: selectedSlotId }).parse(request.params);
    const assigned = store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=?', id).map(row => row.user_id);
    const admin = request.user.role === 'admin';
    if (!assigned.includes(request.user.id) && !admin) throw new HttpError(403, '无权使用该授权槽位，请联系管理员授予访问权限');
    const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', id);
    if (!slot) throw new HttpError(404, '槽位不存在');
    // The CLI runs with a user's profile in the slot; an administrator without access borrows the one already there.
    const active = config.credentials.activeUserId(id);
    const userId = assigned.includes(request.user.id) ? request.user.id : active && assigned.includes(active) ? active : assigned[0];
    if (!userId) throw new HttpError(409, '槽位尚未分配给用户，分配后再刷新模型列表');
    const current = slotForUser(store, id, userId, slot.engine);
    try {
      const catalog = await refreshModelCatalog(config, { user: { id: userId }, slot: current, session: { engine: current.engine } });
      announceSlotChange(context, assigned);
      return catalog;
    } catch (error) { throw catalogError(error); }
  });
}
