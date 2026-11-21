import type { Context } from '../../context.js';
import { HttpError, type Slot, type User } from '../../models.js';
import { canResetLimits, slotForUser } from '../access.js';
import type { SlotUsage, SlotUsageView } from '../usage.js';
import { claudeProbe, type Probe } from '../usage-probes.js';
import { claudeLimitReset } from './claude-terminal.js';
import { codexLimitReset } from './codex.js';
import type { AgentEngine } from '../../agent/engines.js';

export interface LimitResetResult {
  outcome: string;
  message: string;
  /** What the CLI itself answered, when it said something. */
  detail: string | null;
  usage: SlotUsageView;
}

// One reset at a time per slot, so a repeated click cannot spend a second Codex credit.
const resetting = new Set<string>();

function findSlot(context: Context, slotId: string, user: Pick<User, 'id' | 'role'>): Slot {
  if (user.role !== 'admin') return slotForUser(context.store, slotId, user.id, undefined, false);
  const slot = context.store.get<Slot>('SELECT * FROM account_slots WHERE id=?', slotId);
  if (!slot) throw new HttpError(404, '槽位不存在');
  return slot;
}

/** Spends one of the slot's rate-limit resets for an administrator, or for an assigned member the slot allows. */
export async function resetSlotLimit(context: Context, slotId: string, user: Pick<User, 'id' | 'role'>,
  creditId?: string): Promise<LimitResetResult> {
  const slot = findSlot(context, slotId, user);
  if (!canResetLimits(context.store, slot, user.id)) throw new HttpError(403, '管理员未允许成员使用该槽位的额度重置');
  if (slot.status === 'DISABLED') throw new HttpError(409, '槽位已停用');
  if (slot.auth_method === 'token') throw new HttpError(409, '长期令牌账号无法使用额度重置');
  if (creditId !== undefined && slot.engine !== 'codex') throw new HttpError(400, '只有 Codex 账号可以指定重置卡');
  if (resetting.has(slot.id)) throw new HttpError(409, '该槽位正在重置额度，请稍候');
  const usage = context.config.usage!;
  resetting.add(slot.id);
  try {
    const identity = await usage.captureIdentity(slot);
    return await usage.isolated(slot, probe => resets[slot.engine](usage, slot, probe, identity, creditId));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, `额度重置失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    resetting.delete(slot.id);
  }
}

// Claude's reset only refills the 5-hour window, and the CLI offers it only once that window refuses requests.
async function resetClaude(usage: SlotUsage, slot: Slot, probe: Probe, identity: string | null): Promise<LimitResetResult> {
  const before = await usage.record(slot, await claudeProbe(probe), identity);
  const used = (key: string) => before.windows.find(window => window.key === key)?.usedPercent ?? 0;
  if (used('seven_day') >= 100) {
    return { outcome: 'weekly_limited', message: '每周额度已用尽，重置 5 小时额度无法恢复使用，未执行重置', detail: null, usage: before };
  }
  if (used('five_hour') < 100) {
    return { outcome: 'not_limited', message: '5 小时额度尚未用尽，无需重置', detail: null, usage: before };
  }
  const result = await claudeLimitReset(probe);
  // The reset has already happened or not; a failed reading afterwards must not report it as failed.
  const after = await claudeProbe(probe).then(update => usage.record(slot, update, identity), () => usage.view(slot.id));
  return { ...result, usage: after };
}

async function resetCodex(usage: SlotUsage, slot: Slot, probe: Probe, identity: string | null, creditId?: string): Promise<LimitResetResult> {
  const result = await codexLimitReset(probe, creditId);
  return { outcome: result.outcome, message: result.message, detail: null, usage: await usage.record(slot, result.usage, identity) };
}

const resets: Record<AgentEngine, typeof resetCodex> = { claude: resetClaude, codex: resetCodex };
