import type { Store } from '../database.js';
import { HttpError, type Slot } from '../models.js';
import type { QuotaFailure } from '../agent/types.js';
import type { AccountCredentials } from './credentials.js';
import { availableSlots, slotForUser } from './access.js';
import { sameUsageAccount, type SlotUsage, type SlotUsageView, type UsageWindow } from './usage.js';
import { engineProfiles, type AgentEngine } from '../agent/engines.js';

interface SelectionConfig {
  credentials: AccountCredentials;
  usage: SlotUsage;
  autoSlotMinRemainingPercent: number;
  egress?: { assertBound(slotId: string): Promise<void> };
}

interface SelectionRequest {
  userId: string;
  engine: AgentEngine;
  model?: string | null;
  preferredSlotId?: string | null;
  exclude?: string[];
  signal?: AbortSignal;
}

/** Only engines whose conversations can move between accounts let the Hub choose the account. */
export function assertAutomaticSlot(engine: AgentEngine): void {
  const profile = engineProfiles[engine];
  if (!profile.automaticSlot) throw new HttpError(409, `${profile.label} 尚未完成跨账号验证，请选择固定账号`);
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

function relevantAntigravityWindows(windows: UsageWindow[], model?: string | null): UsageWindow[] {
  if (!windows.length) return [];
  const text = (window: UsageWindow) => `${window.key} ${window.label}`.toLowerCase();
  const target = model?.trim().toLowerCase() ?? '';
  if (!target) {
    const gemini = windows.filter(window => text(window).includes('gemini'));
    const mainGemini = gemini.filter(window => !text(window).includes('flash'));
    return mainGemini.length ? mainGemini : gemini.length ? gemini : windows;
  }
  if (target.includes('claude') || target.includes('opus') || target.includes('sonnet') || target.includes('haiku')) {
    const matched = windows.filter(window => text(window).includes('claude') || text(window).includes('anthropic'));
    if (matched.length) return matched;
  } else if (target.includes('gpt') || target.includes('codex') || /^o[134](-|$)/.test(target)) {
    const matched = windows.filter(window => text(window).includes('gpt') || text(window).includes('codex') || text(window).includes('openai'));
    if (matched.length) return matched;
  } else if (target.includes('gemini')) {
    const gemini = windows.filter(window => text(window).includes('gemini'));
    if (gemini.length) {
      const scoped = target.includes('flash')
        ? gemini.filter(window => text(window).includes('flash'))
        : gemini.filter(window => !text(window).includes('flash'));
      return scoped.length ? scoped : gemini;
    }
  }
  const prefix = target.split(/[-_/: ]+/)[0] ?? '';
  if (prefix.length >= 2) {
    const matched = windows.filter(window => text(window).includes(prefix));
    if (matched.length) return matched;
  }
  return windows;
}

function relevantCodexWindows(windows: UsageWindow[], model?: string | null): UsageWindow[] {
  if (!windows.length) return [];
  const account = windows.filter(window => window.key.startsWith('codex:'));
  const target = model?.trim().toLowerCase() ?? '';
  if (!target) return account.length ? account : windows;
  const specific = windows.filter(window => {
    if (window.key.startsWith('codex:')) return false;
    const text = `${window.key} ${window.label}`.toLowerCase();
    return target.split(/[-_/: ]+/).some(token => token.length >= 3 && token !== 'gpt' && token !== 'codex' && text.includes(token));
  });
  const combined = [...account, ...specific];
  return combined.length ? combined : windows;
}

export function relevantWindowsForEngine(engine: AgentEngine, windows: UsageWindow[], model?: string | null): UsageWindow[] {
  if (engine === 'claude') return windows.filter(window => relevantWindow(window.key, model));
  if (engine === 'antigravity') return relevantAntigravityWindows(windows, model);
  return relevantCodexWindows(windows, model);
}

export interface SlotQuotaAssessment {
  limited: boolean;
  headroom: number | null;
  nextResetMs: number;
  known: boolean;
}

/** Evaluates a slot's cached quota snapshot for scheduling, ignoring limits whose resetsAt has already passed. */
export function assessSlotUsage(
  engine: AgentEngine,
  view: SlotUsageView | undefined,
  blocked: boolean,
  model?: string | null,
  now = Date.now(),
): SlotQuotaAssessment {
  if (!view || view.state !== 'ok') {
    return { limited: blocked, headroom: null, nextResetMs: Number.POSITIVE_INFINITY, known: false };
  }
  const windows = relevantWindowsForEngine(engine, view.windows, model);
  let minHeadroom: number | null = null;
  let anyActiveLimit = false;
  let anyUnexpiredWindow = false;
  let earliestLimitReset = Number.POSITIVE_INFINITY;
  const evaluated = windows.map(window => {
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    const hasReset = Number.isFinite(resetMs);
    const resetPassed = hasReset && resetMs <= now;
    if (hasReset && !resetPassed) anyUnexpiredWindow = true;
    const effectiveUsed = resetPassed ? 0 : window.usedPercent;
    const winHeadroom = effectiveUsed !== null && Number.isFinite(effectiveUsed) ? Math.max(0, 100 - effectiveUsed) : null;
    const winLimited = !resetPassed && (window.limited === true || (effectiveUsed !== null && effectiveUsed >= 100));
    if (winLimited) {
      anyActiveLimit = true;
      if (hasReset) earliestLimitReset = Math.min(earliestLimitReset, resetMs);
    }
    if (winHeadroom !== null) minHeadroom = minHeadroom === null ? winHeadroom : Math.min(minHeadroom, winHeadroom);
    return { window, resetMs, hasReset, resetPassed, winHeadroom };
  });
  let viewLimited = false;
  if (view.limited === true) {
    const limiter = view.limitingWindow;
    const irrelevantClaudeModel = engine === 'claude' && !!limiter
      && ['seven_day_opus', 'seven_day_sonnet'].includes(limiter) && !relevantWindow(limiter, model);
    if (!irrelevantClaudeModel) {
      const limiterWin = limiter ? evaluated.find(item => item.window.key === limiter) : undefined;
      if (limiterWin) viewLimited = !limiterWin.resetPassed;
      else if (evaluated.length > 0 && evaluated.every(item => item.hasReset && item.resetPassed)) viewLimited = false;
      else viewLimited = true;
    }
  }
  if (blocked || anyActiveLimit || viewLimited) {
    const futureResets = evaluated.filter(item => item.hasReset && !item.resetPassed).map(item => item.resetMs);
    const nextResetMs = Number.isFinite(earliestLimitReset)
      ? earliestLimitReset
      : futureResets.length ? Math.min(...futureResets) : Number.POSITIVE_INFINITY;
    return { limited: true, headroom: 0, nextResetMs, known: true };
  }
  let nextResetMs = Number.POSITIVE_INFINITY;
  if (minHeadroom !== null) {
    const bottlenecks = evaluated.filter(item => item.winHeadroom !== null && Math.abs(item.winHeadroom - minHeadroom!) < 1);
    const futureResets = bottlenecks.filter(item => item.hasReset && !item.resetPassed).map(item => item.resetMs);
    nextResetMs = futureResets.length ? Math.min(...futureResets) : anyUnexpiredWindow ? Number.POSITIVE_INFINITY : 0;
  }
  return { limited: false, headroom: minHeadroom, nextResetMs, known: minHeadroom !== null };
}

function bottleneckResetMs(view: SlotUsageView, headroom: number, model?: string | null): number {
  const now = Date.now();
  const windows = view.windows.filter(window => relevantWindow(window.key, model) && window.usedPercent !== null);
  const bottlenecks = windows.filter(window => Math.abs((100 - window.usedPercent!) - headroom) < 1);
  const futureResets = bottlenecks.map(window => (window.resetsAt ? Date.parse(window.resetsAt) : NaN))
    .filter(ms => Number.isFinite(ms) && ms > now);
  if (futureResets.length) return Math.min(...futureResets);
  return bottlenecks.some(window => !window.resetsAt) ? 0 : Number.POSITIVE_INFINITY;
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

  cooldownUntil(slotId: string, model?: string | null): string | null {
    const identity = this.config.usage.accountIdentity(slotId);
    const active = this.store.all<{ window_key: string; resets_at: string; account_key: string | null }>(
      `SELECT window_key,resets_at,account_key FROM slot_quota_limits
        WHERE slot_id=? OR (account_key<>'' AND account_key=?)`, slotId, identity,
    ).filter(limit => relevantWindow(limit.window_key, model) && Date.parse(limit.resets_at) > Date.now()
      && sameUsageAccount(limit.account_key, identity))
      .sort((a, b) => Date.parse(b.resets_at) - Date.parse(a.resets_at));
    return active[0]?.resets_at ?? null;
  }

  isBlocked(slot: Pick<Slot, 'id'>, model?: string | null): boolean {
    return this.cooldownUntil(slot.id, model) !== null;
  }

  private blocked(slot: Slot, model?: string | null): boolean {
    return this.isBlocked(slot, model);
  }

  /** Ranks usable slots by model support, non-limited status, remaining headroom, and reset health. */
  rankSlots(slots: Slot[], engine: AgentEngine, model?: string | null, supportsModel?: (slotId: string) => boolean): Slot[] {
    const now = Date.now();
    const minHeadroom = this.config.autoSlotMinRemainingPercent;
    return slots.map(slot => {
      const blocked = this.isBlocked(slot, model);
      const assessment = assessSlotUsage(engine, this.config.usage.view(slot.id), blocked, model, now);
      const tier = assessment.limited ? 3
        : !assessment.known ? 1
          : assessment.headroom! >= minHeadroom ? 0 : 2;
      const modelOk = supportsModel ? supportsModel(slot.id) : true;
      return { slot, assessment, tier, modelOk };
    }).sort((a, b) => Number(b.modelOk) - Number(a.modelOk)
      || a.tier - b.tier
      || (b.assessment.headroom ?? -1) - (a.assessment.headroom ?? -1)
      || a.assessment.nextResetMs - b.assessment.nextResetMs
      || a.slot.id.localeCompare(b.slot.id)).map(item => item.slot);
  }

  eligible(slot: Pick<Slot, 'id' | 'credential_revision'>, userId: string, model?: string | null): Slot | undefined {
    let current: Slot;
    try { current = slotForUser(this.store, slot.id, userId, 'claude'); }
    catch (error) { if (error instanceof HttpError) return undefined; throw error; }
    const occupant = this.config.credentials.activeUserId(slot.id);
    if (current.credential_revision !== slot.credential_revision || occupant && occupant !== userId || this.blocked(current, model)) return undefined;
    // A long-lived token cannot read its quota, so it never proves enough headroom for automatic use.
    if (current.auth_method === 'token') return undefined;
    const headroom = remaining(this.config.usage.view(slot.id), model);
    return headroom !== null && headroom >= this.config.autoSlotMinRemainingPercent ? current : undefined;
  }

  async ensureEligible(slot: Slot, userId: string, model?: string | null): Promise<void> {
    if (slot.auth_method === 'token') throw new HttpError(409, '使用长期令牌的账号不参与自动选择，请改为固定账号');
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
    assertAutomaticSlot(request.engine);
    const excluded = new Set(request.exclude);
    const slots = availableSlots(this.store, request.userId).filter(slot => slot.engine === request.engine
      && slot.status === 'IDLE' && slot.auth_method !== 'token' && !excluded.has(slot.id));
    const inspected = await Promise.all(slots.map(slot => this.inspect(slot, request)));
    request.signal?.throwIfAborted();
    const candidates = inspected.filter((slot): slot is Slot => slot !== null)
      .flatMap(slot => {
        const current = this.eligible(slot, request.userId, request.model);
        if (!current) return [];
        const view = this.config.usage.view(current.id);
        const headroom = remaining(view, request.model)!;
        return [{ slot: current, headroom, resetMs: bottleneckResetMs(view, headroom, request.model) }];
      })
      .sort((a, b) => Number(b.slot.id === request.preferredSlotId) - Number(a.slot.id === request.preferredSlotId)
        || b.headroom - a.headroom || a.resetMs - b.resetMs || a.slot.id.localeCompare(b.slot.id)).map(item => item.slot);
    if (!candidates.length) throw new HttpError(409,
      `没有可自动使用的 Claude 账号：需要浏览器登录、访问权限、可用出口、最新额度，且相关窗口至少剩余 ${this.config.autoSlotMinRemainingPercent}%`);
    return candidates;
  }

  async select(request: SelectionRequest, validate?: (slot: Slot) => Promise<void>): Promise<Slot> {
    assertAutomaticSlot(request.engine);
    let lastError: unknown;
    const excluded = [...(request.exclude ?? [])];
    const preferred = availableSlots(this.store, request.userId).find(slot => slot.id === request.preferredSlotId
      && slot.engine === request.engine && slot.status === 'IDLE' && slot.auth_method !== 'token' && !excluded.includes(slot.id));
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
