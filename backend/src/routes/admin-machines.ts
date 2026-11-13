import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { withResourceLocks, type Context } from '../context.js';
import { assertWithinQuota, machineResourceSettingsSchema } from '../execution/machine-resources.js';
import { HttpError, type Slot } from '../models.js';

/** CPU, memory and root disk of slot VMs and workspace containers, with each instance's progress toward them. */
export function adminMachineRoutes(app: FastifyInstance, context: Context) {
  const { store } = context;
  async function view() {
    const settings = context.machineResourceSettings.view();
    if (!context.machineResources) return { available: false, settings, machines: [], quota: null };
    const { machines, quota } = await context.machineResources.resources();
    const slots = new Map(store.all<Pick<Slot, 'id' | 'label'>>('SELECT id,label FROM account_slots').map(slot => [slot.id, slot.label]));
    const users = new Map(store.all<{ id: string; username: string }>('SELECT id,username FROM users').map(user => [user.id, user.username]));
    return {
      available: true, settings, quota,
      machines: machines.map(machine => ({ ...machine,
        label: (machine.kind === 'slot' ? slots.get(machine.owner) : users.get(machine.owner)) ?? null })),
    };
  }
  app.get('/api/admin/machine-resources', async request => {
    requireAdmin(request);
    return view();
  });
  app.put('/api/admin/machine-resources', async request => {
    requireAdmin(request);
    const settings = machineResourceSettingsSchema.parse(request.body);
    return withResourceLocks(context, ['machine-resources'], async () => {
      if (context.machineResources) {
        const { machines, quota } = await context.machineResources.resources();
        try { assertWithinQuota(quota, machines, settings); }
        catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
      }
      context.machineResourceSettings.update(settings);
      await context.machineResources?.applyResources();
      return view();
    });
  });
  // A running slot VM takes new resources only when it starts again, and a smaller disk only when it is rebuilt.
  app.post('/api/admin/machine-resources/slots/:id/restart', async request => {
    requireAdmin(request);
    const { id } = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/) }).parse(request.params);
    const { rebuild } = z.object({ rebuild: z.boolean().default(false) }).strict().parse(request.body ?? {});
    const host = context.machineResources;
    if (!host) throw new HttpError(409, '当前为宿主机执行模式，没有槽位虚拟机');
    return withResourceLocks(context, [`slot-config:${id}`, 'machine-resources'], async () => {
      await context.agents.reclaimWhere({ slotId: id });
      const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', id);
      if (!slot) throw new HttpError(404, '槽位不存在');
      const { config } = context;
      const stopped = await config.credentials.whileIdle(id, async () => {
        try { await config.execution.assertReleased(slot.home_dir); }
        catch (error) { throw new HttpError(409, `无法停止槽位虚拟机：${error instanceof Error ? error.message : String(error)}`); }
        // The slot's home lives on the host, so a rebuilt VM comes back with the same login and files.
        await config.execution.retire('slot', id, rebuild);
      });
      if (!stopped) throw new HttpError(409, '该槽位正在使用或查询额度，请结束后再重启');
      if (!rebuild) await host.applyResources();
      return view();
    });
  });
}
