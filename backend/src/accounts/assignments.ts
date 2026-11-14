import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withResourceLocks, type Context } from '../context.js';
import { availableSlots, serializeUserSlot } from './access.js';
import { clearClaudeLogin } from './credential-files.js';
import { accountIdentifier } from './paths.js';
import { HttpError, type Slot } from '../models.js';

interface SlotUpdate {
  label?: string;
  status?: Slot['status'];
  allowedUserIds?: string[];
  membersCanReset?: boolean;
  expectedRevision?: number;
}

export async function updateSlot(context: Context, slotId: string, input: SlotUpdate): Promise<Slot> {
  const { store, config } = context;
  return withResourceLocks(context, [`slot-config:${slotId}`], async () => {
    // Idle resident CLIs give the slot back; ones still working keep it and block the change.
    await context.agents.reclaimWhere({ slotId });
    const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId);
    if (!slot) throw new HttpError(404, '槽位不存在');
    if (input.expectedRevision !== undefined && input.expectedRevision !== slot.credential_revision) {
      throw new HttpError(409, '槽位配置已变化，请刷新后确认');
    }
    const previousUsers = store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=?', slotId).map(row => row.user_id);
    const allowedUsers = input.allowedUserIds === undefined ? previousUsers : [...new Set(input.allowedUserIds)];
    for (const userId of allowedUsers) {
      const user = store.get<{ suspended_at: string | null }>('SELECT suspended_at FROM users WHERE id=?', userId);
      if (!user) throw new HttpError(404, '授权用户不存在');
      if (user.suspended_at && !previousUsers.includes(userId)) throw new HttpError(409, '该用户已停用，恢复后才能分配槽位');
    }
    const accessChanged = previousUsers.length !== allowedUsers.length || previousUsers.some(userId => !allowedUsers.includes(userId));
    const status = input.status ?? slot.status;
    const accountChanged = accessChanged || status !== slot.status;
    // A parked lease is tied to the current revision, so it must be saved before the revision changes.
    if (accountChanged) await config.credentials.releaseParked(slotId);
    if (accountChanged && config.credentials.isSlotBusy(slotId)) {
      throw new HttpError(409, '该槽位正在使用，请等待相关会话和模型查询结束后再修改状态或访问权限');
    }
    const updated = store.transaction(() => {
      if (accessChanged) {
        store.run('DELETE FROM slot_user_access WHERE slot_id=?', slotId);
        for (const userId of allowedUsers) store.run('INSERT INTO slot_user_access(slot_id,user_id) VALUES(?,?)', slotId, userId);
      }
      store.run(`UPDATE account_slots SET label=?,status=?,members_can_reset=?,credential_revision=credential_revision+?,
        updated_at=datetime('now') WHERE id=?`, input.label ?? slot.label, status,
      input.membersCanReset === undefined ? slot.members_can_reset : input.membersCanReset ? 1 : 0, accountChanged ? 1 : 0, slotId);
      return store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId)!;
    });
    announceSlotChange(context, [...previousUsers, ...allowedUsers]);
    return updated;
  });
}

/**
 * Deletes a disabled slot with its login, home directory and machine. Conversations that chose it keep their
 * history and ask for another slot. Token usage keeps the slot ID as a historical record.
 */
export async function deleteSlot(context: Context, slotId: string): Promise<void> {
  const { store, config } = context;
  return withResourceLocks(context, [`slot-config:${slotId}`], async () => {
    await context.agents.reclaimWhere({ slotId });
    const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId);
    if (!slot) throw new HttpError(404, '槽位不存在');
    if (slot.status !== 'DISABLED') throw new HttpError(409, '请先停用槽位，再删除');
    const users = store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=?', slotId).map(row => row.user_id);
    // The home is deleted recursively, so it must be this slot's own directory under the data directory.
    if (resolve(slot.home_dir) !== resolve(config.dataDir, 'slots', accountIdentifier(slotId))) {
      throw new HttpError(409, `槽位目录 ${slot.home_dir} 不在数据目录的 slots 下，请手动清理后再删除`);
    }
    const removed = await config.credentials.whileIdle(slotId, async () => {
      try { await config.execution.assertReleased(slot.home_dir); }
      catch (error) { throw new HttpError(409, `无法删除槽位：${error instanceof Error ? error.message : String(error)}`); }
      await config.execution.retire('slot', slotId, true);
      await config.credentials.tokens.remove(slotId);
      store.transaction(() => {
        store.run('UPDATE sessions SET slot_id=NULL WHERE slot_id=?', slotId);
        store.run('DELETE FROM account_slots WHERE id=?', slotId);
      });
      await Promise.all([
        slot.home_dir,
        join(config.dataDir, 'run', 'usage-probes', accountIdentifier(slotId)),
        join(config.dataDir, 'accounts', 'slot-runtime', `${accountIdentifier(slotId)}.json`),
      ].map(path => rm(path, { recursive: true, force: true })));
    });
    if (!removed) throw new HttpError(409, '该槽位正在使用或查询额度，请结束后再删除');
    announceSlotChange(context, users);
  });
}

/** Switches a Claude slot between a browser login and a long-lived token from `claude setup-token`. */
export async function setSlotToken(context: Context, slotId: string, token: { value: string; expiresAt: string } | null): Promise<Slot> {
  const { store, config } = context;
  return withResourceLocks(context, [`slot-config:${slotId}`], async () => {
    await context.agents.reclaimWhere({ slotId });
    const slot = store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId);
    if (!slot) throw new HttpError(404, '槽位不存在');
    if (slot.engine !== 'claude') throw new HttpError(400, '只有 Claude Code 槽位支持长期令牌');
    const switched = await config.credentials.whileIdle(slotId, async () => {
      await config.execution.assertReleased(slot.home_dir);
      if (token) await config.credentials.tokens.write(slotId, token.value);
      store.run(`UPDATE account_slots SET auth_method=?,token_expires_at=?,credential_revision=credential_revision+1,
        updated_at=datetime('now') WHERE id=?`, token ? 'token' : 'oauth', token?.expiresAt ?? null, slotId);
      // A leftover browser login would stay readable to agents although the slot no longer uses it.
      if (token) await clearClaudeLogin(slot.home_dir);
      else await config.credentials.tokens.remove(slotId);
      return store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId)!;
    });
    if (!switched) throw new HttpError(409, '该槽位正在使用或查询额度，请结束后再修改登录方式');
    announceSlotChange(context, store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=?', slotId)
      .map(row => row.user_id));
    return switched.value;
  });
}

export function announceSlotChange(context: Context, userIds: string[]): void {
  const { store, events } = context;
  const administrators = store.all<{ id: string }>("SELECT id FROM users WHERE role='admin'").map(user => user.id);
  for (const userId of new Set([...userIds, ...administrators])) {
    events.emit(userId, { type: 'slot', payload: { slots: availableSlots(store, userId).map(item => serializeUserSlot(context, item, userId)) } });
  }
}
