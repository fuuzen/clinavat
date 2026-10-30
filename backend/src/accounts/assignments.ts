import { withResourceLocks, type Context } from '../context.js';
import { invalidateUserModels } from '../agent/model-catalog.js';
import { availableSlots, serializeUserSlot } from './access.js';
import { HttpError, type Slot } from '../models.js';

interface SlotUpdate {
  label?: string;
  status?: Slot['status'];
  allowedUserIds?: string[];
  expectedRevision?: number;
}

export async function updateSlot(context: Context, slotId: string, input: SlotUpdate): Promise<Slot> {
  const { store, config, events } = context;
  return withResourceLocks(context, [`slot-config:${slotId}`], () => {
    const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId);
    if (!slot) throw new HttpError(404, '槽位不存在');
    if (input.expectedRevision !== undefined && input.expectedRevision !== slot.credential_revision) {
      throw new HttpError(409, '槽位配置已变化，请刷新后确认');
    }
    const previousUsers = store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=?', slotId).map(row => row.user_id);
    const allowedUsers = input.allowedUserIds === undefined ? previousUsers : [...new Set(input.allowedUserIds)];
    for (const userId of allowedUsers) {
      if (!store.get('SELECT id FROM users WHERE id=?', userId)) throw new HttpError(404, '授权用户不存在');
    }
    const accessChanged = previousUsers.length !== allowedUsers.length || previousUsers.some(userId => !allowedUsers.includes(userId));
    const status = input.status ?? slot.status;
    const accountChanged = accessChanged || status !== slot.status;
    if (accountChanged && config.credentials.isSlotBusy(slotId)) {
      throw new HttpError(409, '该槽位正在使用，请等待相关会话和模型查询结束后再修改状态或访问权限');
    }
    const updated = store.transaction(() => {
      if (accessChanged) {
        store.run('DELETE FROM slot_user_access WHERE slot_id=?', slotId);
        for (const userId of allowedUsers) store.run('INSERT INTO slot_user_access(slot_id,user_id) VALUES(?,?)', slotId, userId);
      }
      store.run(`UPDATE account_slots SET label=?,status=?,credential_revision=credential_revision+?,updated_at=datetime('now') WHERE id=?`,
        input.label ?? slot.label, status, accountChanged ? 1 : 0, slotId);
      return store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId)!;
    });
    const administrators = store.all<{ id: string }>("SELECT id FROM users WHERE role='admin'").map(user => user.id);
    for (const userId of new Set([...previousUsers, ...allowedUsers, ...administrators])) {
      invalidateUserModels(userId);
      events.emit(userId, { type: 'slot', payload: { slots: availableSlots(store, userId).map(item => serializeUserSlot(context, item, userId)) } });
    }
    return updated;
  });
}
