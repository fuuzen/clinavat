import type { Store } from '../database.js';
import type { Context } from '../context.js';
import { HttpError, type Slot } from '../models.js';
import type { AccountEngine } from './paths.js';

export function availableSlots(store: Store, userId: string): Slot[] {
  return store.all<Slot>(`SELECT account_slots.* FROM account_slots JOIN slot_user_access
    ON slot_user_access.slot_id=account_slots.id WHERE slot_user_access.user_id=? ORDER BY account_slots.label,account_slots.id`, userId);
}

export function slotForUser(store: Store, slotId: string, userId: string, engine?: AccountEngine, requireUsable = true): Slot {
  const slot = store.get<Slot>(`SELECT account_slots.* FROM account_slots JOIN slot_user_access
    ON slot_user_access.slot_id=account_slots.id WHERE account_slots.id=? AND slot_user_access.user_id=?`, slotId, userId);
  if (!slot) throw new HttpError(403, '无权使用该授权槽位，请联系管理员授予访问权限');
  if (engine && slot.engine !== engine) throw new HttpError(409, '授权槽位与当前对话的引擎不匹配');
  if (requireUsable && slot.status !== 'IDLE') throw new HttpError(409, slot.status === 'RATE_LIMITED' ? '该授权槽位额度受限，请切换槽位' : '该授权槽位已停用，请切换槽位');
  return slot;
}

export function serializeSlot(slot: Slot) {
  const { home_dir: _home, model_catalog: _catalog, ...publicSlot } = slot;
  return { ...publicSlot, members_can_reset: slot.members_can_reset === 1, max_concurrent_users: 1 as const };
}

export function canResetLimits(store: Store, slot: Slot, userId: string): boolean {
  return slot.members_can_reset === 1 || store.get<{ role: string }>('SELECT role FROM users WHERE id=?', userId)?.role === 'admin';
}

export function serializeUserSlot(context: Context, slot: Slot, userId: string) {
  const activeUserId = context.config.credentials.activeUserId(slot.id);
  return { ...serializeSlot(slot), in_use: activeUserId !== null, in_use_by_you: activeUserId === userId,
    can_reset_limits: canResetLimits(context.store, slot, userId) };
}

export function serializeAdminSlot(context: Context, slot: Slot) {
  return {
    ...serializeSlot(slot), home_dir: slot.home_dir,
    allowed_user_ids: context.store.all<{ user_id: string }>('SELECT user_id FROM slot_user_access WHERE slot_id=? ORDER BY user_id', slot.id).map(row => row.user_id),
    active_user_id: context.config.credentials.activeUserId(slot.id),
  };
}
