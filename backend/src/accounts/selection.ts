import type { Store } from '../database.js';
import { HttpError, type Slot } from '../models.js';
import type { QuotaFailure } from '../agent/types.js';
import type { AccountCredentials } from './credentials.js';
import { availableSlots, slotForUser } from './access.js';
import { sameUsageAccount, type SlotUsage, type SlotUsageView, type UsageWindow } from './usage.js';

interface SelectionConfig {
  credentials: AccountCredentials;
  usage: SlotUsage;
  autoSlotMinRemainingPercent: number;
  egress?: { assertBound(slotId: string): Promise<void> };
}

interface SelectionRequest {
  userId: string;
  engine: 'claude' | 'codex';
  model?: string | null;
  preferredSlotId?: string | null;
  exclude?: string[];
  signal?: AbortSignal;
}

function modelFamily(model?: string | null): string | null {
  return ['opus', 'sonnet', 'haiku', 'fable'].find(family => model?.toLowerCase().includes(family)) ?? null;
}

function relevantWindow(key: string, model?: string | null): boolean {
  if (['overage', 'extra_usage', 'seven_day_overage_included'].includes(key)) return false;
  const family = modelFamily(model);
  if (key === 'seven_day_opus') return !family || family === 'opus';
  if (key === 'seven_day_sonnet') return !family || family === 'sonnet';
  if (key.startsWith('model:')) {
    const scopedFamily = modelFamily(key);
    return !family || !scopedFamily || family === scopedFamily;
  }
  return true;
}

function remaining(view: SlotUsageView, model?: string | null): number | null {
  if (view.state !== 'ok' || view.stale || !view.observedAt || Date.now() - Date.parse(view.observedAt) > 60_000) return null;
  const windows = view.windows.filter(window => relevantWindow(window.key, model));
  // A partial live event alone cannot establish that the other subscription window has headroom.
  if (!['five_hour', 'seven_day'].every(key => windows.some(window => window.key === key))) return null;
  if (view.limited) {
    const limiter = view.limitingWindow;
    const irrelevantModelLimit = !!limiter && ['seven_day_opus', 'seven_day_sonnet'].includes(limiter)
      && !relevantWindow(limiter, model);
    if (!irrelevantModelLimit) return null;
  }
  if (windows.some(window => window.limited || window.usedPercent === null)) return null;
  if (windows.some(window => !Number.isFinite(Date.parse(window.observedAt ?? ''))
    || Date.now() - Date.parse(window.observedAt!) > 60_000)) return null;
  return Math.min(...windows.map((window: UsageWindow) => 100 - window.usedPercent!));
}

/** Selects only authorized subscription slots. A lease, acquired by the caller, remains the final reservation. */
export class SlotSelector {
  constructor(private store: Store, private config: SelectionConfig) {}

  recordLimit(slot: Pick<Slot, 'id' | 'credential_revision'>, quota: QuotaFailure, identity: string | null): void {
    if (!quota.resetsAt || !Number.isFinite(Date.parse(quota.resetsAt))) return;
    this.store.run(`INSERT INTO slot_quota_limits(slot_id,credential_revision,window_key,resets_at,account_key) VALUES(?,?,?,?,?)
      ON CONFLICT(slot_id,account_key,window_key) DO UPDATE SET resets_at=MAX(slot_quota_limits.resets_at,excluded.resets_at),
        credential_revision=excluded.credential_revision,recorded_at=datetime('now')`,
    slot.id, slot.credential_revision, quota.window, quota.resetsAt, identity ?? '');
  }

  private blocked(slot: Slot, model?: string | null): boolean {
    const identity = this.config.usage.accountIdentity(slot.id);
    return this.store.all<{ window_key: string; resets_at: string; account_key: string | null }>(
      `SELECT window_key,resets_at,account_key FROM slot_quota_limits
        WHERE slot_id=? OR (account_key<>'' AND account_key=?)`, slot.id, identity,
    ).some(limit => relevantWindow(limit.window_key, model) && Date.parse(limit.resets_at) > Date.now()
      && sameUsageAccount(limit.account_key, identity));
  }

  eligible(slot: Pick<Slot, 'id' | 'credential_revision'>, userId: string, model?: string | null): Slot | undefined {
    let current: Slot;
    try { current = slotForUser(this.store, slot.id, userId, 'claude'); }
    catch (error) { if (error instanceof HttpError) return undefined; throw error; }
    const occupant = this.config.credentials.activeUserId(slot.id);
    if (current.credential_revision !== slot.credential_revision || occupant && occupant !== userId || this.blocked(current, model)) return undefined;
    const headroom = remaining(this.config.usage.view(slot.id), model);
    return headroom !== null && headroom >= this.config.autoSlotMinRemainingPercent ? current : undefined;
  }

  async ensureEligible(slot: Slot, userId: string, model?: string | null): Promise<void> {
    const view = (await this.config.usage.views([slot]))[slot.id];
    if (remaining(view, model) === null) await this.config.usage.refresh(slot);
    if (!this.eligible(slot, userId, model)) throw new HttpError(409, '账号额度、权限或占用状态已变化，请重新选择可用账号');
  }

  private async inspect(slot: Slot, request: SelectionRequest): Promise<Slot | null> {
    request.signal?.throwIfAborted();
    const occupant = this.config.credentials.activeUserId(slot.id);
    if (occupant && occupant !== request.userId) return null;
    try {
      const view = (await this.config.usage.views([slot]))[slot.id];
      if (this.blocked(slot, request.model)) return null;
      await this.config.egress?.assertBound(slot.id);
      if (remaining(view, request.model) === null) await this.config.usage.refresh(slot);
      request.signal?.throwIfAborted();
      return this.eligible(slot, request.userId, request.model) ?? null;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      return null;
    }
  }

  async candidates(request: SelectionRequest): Promise<Slot[]> {
    if (request.engine !== 'claude') throw new HttpError(409, 'Codex 尚未完成跨账号验证，请选择固定账号');
    const excluded = new Set(request.exclude);
    const slots = availableSlots(this.store, request.userId).filter(slot => slot.engine === request.engine
      && slot.status === 'IDLE' && !excluded.has(slot.id));
    const inspected = await Promise.all(slots.map(slot => this.inspect(slot, request)));
    request.signal?.throwIfAborted();
    const candidates = inspected.filter((slot): slot is Slot => slot !== null)
      .flatMap(slot => {
        const current = this.eligible(slot, request.userId, request.model);
        return current ? [{ slot: current, headroom: remaining(this.config.usage.view(current.id), request.model)! }] : [];
      })
      .sort((a, b) => Number(b.slot.id === request.preferredSlotId) - Number(a.slot.id === request.preferredSlotId)
        || b.headroom - a.headroom || a.slot.id.localeCompare(b.slot.id)).map(item => item.slot);
    if (!candidates.length) throw new HttpError(409,
      `没有可自动使用的 Claude 账号：需要访问权限、可用出口、最新额度，且相关窗口至少剩余 ${this.config.autoSlotMinRemainingPercent}%`);
    return candidates;
  }

  async select(request: SelectionRequest, validate?: (slot: Slot) => Promise<void>): Promise<Slot> {
    if (request.engine !== 'claude') throw new HttpError(409, 'Codex 尚未完成跨账号验证，请选择固定账号');
    let lastError: unknown;
    const excluded = [...(request.exclude ?? [])];
    const preferred = availableSlots(this.store, request.userId).find(slot => slot.id === request.preferredSlotId
      && slot.engine === 'claude' && slot.status === 'IDLE' && !excluded.includes(slot.id));
    if (preferred) {
      // Staying on a usable account must not boot every other slot merely to rediscover the same choice.
      const ready = await this.inspect(preferred, request);
      if (ready) {
        try {
          await validate?.(ready);
          const current = this.eligible(ready, request.userId, request.model);
          if (current) return current;
        } catch (error) {
          if (!(error instanceof HttpError) || error.statusCode !== 400) throw error;
          lastError = error;
        }
      }
      excluded.push(preferred.id);
    }
    for (const slot of await this.candidates({ ...request, exclude: excluded })) {
      try {
        await validate?.(slot);
        const current = this.eligible(slot, request.userId, request.model);
        if (current) return current;
        lastError = new HttpError(409, '账号额度、权限或占用状态已变化，请重试');
      }
      catch (error) {
        // Only a known model/effort mismatch is safe to try on another account.
        if (!(error instanceof HttpError) || error.statusCode !== 400) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new HttpError(409, '没有支持当前模型的可用账号');
  }
}
