import type { Context } from '../context.js';
import type { Slot } from '../models.js';
import { agentEngines, engineProfiles } from '../agent/engines.js';
import { availableSlots } from '../accounts/access.js';
import { sameUsageAccount, type SlotUsage, type SlotUsageView } from '../accounts/usage.js';
import { engineSlots } from './children.js';

const TOKEN_UNPROBEABLE_NOTE = '长期令牌（setup-token）不支持主动探测额度，仅在对话运行时更新';
const DISABLED_SLOT_NOTE = '槽位已停用，不可探测额度';

const fallbackWindowLabels: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '每周',
  seven_day_opus: '每周 · Opus',
  seven_day_sonnet: '每周 · Sonnet',
  seven_day_oauth_apps: '每周 · 第三方应用',
  seven_day_overage_included: '每周 · 含超额模型',
  overage: '额外用量',
  extra_usage: '额外用量（本月）',
};

export interface SlotUsageWindowSummary {
  key: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  limited: boolean;
  resetsAt: string | null;
  resetsInSeconds: number | null;
  resetPassed?: true;
}

export interface SlotUsageSummary {
  state: SlotUsageView['state'];
  authMethod: Slot['auth_method'];
  probeable: boolean;
  plan?: string;
  observedAt: string | null;
  stale: boolean;
  limited: boolean | null;
  limitingWindow?: string;
  cooldownUntil: string | null;
  inCooldown: boolean;
  windows: SlotUsageWindowSummary[];
  note?: string;
  error?: string;
}

export interface SlotUsageRefreshResult {
  blockedByMaintenance?: true;
  message?: string;
  refreshed: string[];
  throttled: string[];
  skipped: { slotId: string; reason: string }[];
  failed: { slotId: string; error: string }[];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCoreQuotaWindow(key: string): boolean {
  return key === 'five_hour' || key === 'seven_day' || key.endsWith(':primary') || key.endsWith(':secondary');
}

function activeSlotQuotaLimits(context: Context, slotId: string, identity: string | null, nowMs: number): Map<string, number> {
  const rows = context.store.all<{ window_key: string; resets_at: string; account_key: string | null }>(
    `SELECT window_key,resets_at,account_key FROM slot_quota_limits
      WHERE slot_id=? OR (account_key<>'' AND account_key=?)`,
    slotId,
    identity,
  );
  const active = new Map<string, number>();
  for (const row of rows) {
    if (!sameUsageAccount(row.account_key, identity)) continue;
    const resetsAtMs = parseTimestamp(row.resets_at);
    if (resetsAtMs === null || resetsAtMs <= nowMs) continue;
    const existing = active.get(row.window_key);
    if (existing === undefined || resetsAtMs > existing) active.set(row.window_key, resetsAtMs);
  }
  return active;
}

function formatResetTiming(resetsAtMs: number | null, nowMs: number): { resetsInSeconds: number | null; resetPassed?: true } {
  if (resetsAtMs === null) return { resetsInSeconds: null };
  const deltaMs = resetsAtMs - nowMs;
  if (deltaMs <= 0) return { resetsInSeconds: 0, resetPassed: true };
  return { resetsInSeconds: Math.ceil(deltaMs / 1000) };
}

export function buildSlotUsageSummary(context: Context, slot: Slot, nowMs = Date.now()): SlotUsageSummary {
  const probeable = slot.auth_method !== 'token' && slot.status !== 'DISABLED';
  const note = slot.status === 'DISABLED' ? DISABLED_SLOT_NOTE
    : slot.auth_method === 'token' ? TOKEN_UNPROBEABLE_NOTE : undefined;
  const usage = context.config.usage;
  if (!usage) {
    return {
      state: 'unavailable',
      authMethod: slot.auth_method,
      probeable: false,
      observedAt: null,
      stale: false,
      limited: null,
      cooldownUntil: null,
      inCooldown: false,
      windows: [],
      note: note ?? '额度服务未启用',
    };
  }

  const view = usage.view(slot.id);
  const identity = usage.accountIdentity(slot.id);
  const activeLimits = activeSlotQuotaLimits(context, slot.id, identity, nowMs);
  const seenKeys = new Set<string>();
  const windows: SlotUsageWindowSummary[] = view.windows.map(window => {
    seenKeys.add(window.key);
    const windowResetMs = parseTimestamp(window.resetsAt);
    const limitResetMs = activeLimits.get(window.key) ?? null;
    const resetsAtMs = limitResetMs !== null && (windowResetMs === null || limitResetMs > windowResetMs)
      ? limitResetMs : windowResetMs;
    const resetsAt = resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null;
    const remainingPercent = window.usedPercent === null ? null : Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10);
    const limited = window.limited === true
      || (view.limited === true && view.limitingWindow === window.key)
      || (window.usedPercent !== null && window.usedPercent >= 100)
      || limitResetMs !== null;
    return {
      key: window.key,
      label: window.label,
      usedPercent: window.usedPercent,
      remainingPercent,
      limited,
      resetsAt,
      ...formatResetTiming(resetsAtMs, nowMs),
    };
  });

  for (const [key, resetsAtMs] of activeLimits) {
    if (seenKeys.has(key)) continue;
    windows.push({
      key,
      label: fallbackWindowLabels[key] ?? key,
      usedPercent: null,
      remainingPercent: null,
      limited: true,
      resetsAt: new Date(resetsAtMs).toISOString(),
      ...formatResetTiming(resetsAtMs, nowMs),
    });
  }

  let cooldownUntilMs: number | null = null;
  for (const resetsAtMs of activeLimits.values()) {
    cooldownUntilMs = cooldownUntilMs === null ? resetsAtMs : Math.max(cooldownUntilMs, resetsAtMs);
  }
  if (slot.engine === 'antigravity') {
    if (windows.length > 0 && windows.every(window => window.limited)) {
      const activeResets = windows
        .map(window => parseTimestamp(window.resetsAt))
        .filter((ms): ms is number => ms !== null && ms > nowMs);
      if (activeResets.length === windows.length) {
        const earliestRecovery = Math.min(...activeResets);
        cooldownUntilMs = cooldownUntilMs === null ? earliestRecovery : Math.max(cooldownUntilMs, earliestRecovery);
      }
    }
  } else {
    for (const window of windows) {
      if (!window.limited) continue;
      const resetsAtMs = parseTimestamp(window.resetsAt);
      if (resetsAtMs === null || resetsAtMs <= nowMs) continue;
      const matchesExplicitLimit = view.limited === true && (!view.limitingWindow || view.limitingWindow === window.key);
      if (matchesExplicitLimit || isCoreQuotaWindow(window.key)) {
        cooldownUntilMs = cooldownUntilMs === null ? resetsAtMs : Math.max(cooldownUntilMs, resetsAtMs);
      }
    }
  }

  const cooldownUntil = cooldownUntilMs !== null ? new Date(cooldownUntilMs).toISOString() : null;
  const inCooldown = cooldownUntil !== null;
  const error = view.error && slot.auth_method !== 'token' && slot.status !== 'DISABLED' ? view.error : undefined;

  return {
    state: view.state,
    authMethod: slot.auth_method,
    probeable,
    ...(view.plan ? { plan: view.plan } : {}),
    observedAt: view.observedAt,
    stale: view.stale,
    limited: inCooldown ? true : view.limited,
    ...(view.limitingWindow ? { limitingWindow: view.limitingWindow } : {}),
    cooldownUntil,
    inCooldown,
    windows,
    ...(note ? { note } : {}),
    ...(error ? { error } : {}),
  };
}

/** Builds the `engines` section of `list_agents` with per-slot quota visibility and VM exclusivity hints. */
export function buildEngineSlotSummaries(context: Context, userId: string, nowMs = Date.now()) {
  const isVmMode = context.config.execution.kind === 'vm';
  return agentEngines.map(engine => {
    const entries = engineSlots(context, userId, engine);
    if (!entries.length) return null;
    const singleMachinePerUser = isVmMode && engineProfiles[engine].sessionFiles.length > 0;
    const activeSlotByYou = entries.find(({ slot }) => context.config.credentials.activeUserId(slot.id) === userId)?.slot.id ?? null;
    return {
      engine,
      label: engineProfiles[engine].label,
      automaticSlot: engineProfiles[engine].automaticSlot,
      ...(singleMachinePerUser ? {
        singleMachinePerUser: true,
        ...(activeSlotByYou ? { activeSlotByYou } : {}),
      } : {}),
      slots: entries.map(({ slot, usable, inUseByOther }) => {
        const inUseByYou = context.config.credentials.activeUserId(slot.id) === userId;
        const vmExclusiveBlockedBy = singleMachinePerUser && activeSlotByYou && activeSlotByYou !== slot.id ? activeSlotByYou : null;
        return {
          id: slot.id,
          label: slot.label,
          usable,
          ...(inUseByYou ? { inUseByYou: true } : {}),
          ...(inUseByOther ? { inUseByOtherUser: true } : {}),
          ...(vmExclusiveBlockedBy ? {
            vmExclusiveBlockedBy,
            vmExclusiveNote: `VM 模式下 ${engineProfiles[engine].label} 同用户单机独占：你正在槽位 ${vmExclusiveBlockedBy} 上运行，请复用该槽位或等待结束后再使用本槽位`,
          } : {}),
          ...(slot.status !== 'IDLE' ? { status: slot.status } : {}),
          usage: buildSlotUsageSummary(context, slot, nowMs),
          models: context.config.catalogs.read(slot.id)?.models.map(model => ({
            id: model.id,
            efforts: model.reasoningEfforts.map(effort => effort.value),
            ...(model.isDefault ? { default: true } : {}),
          })) ?? 'not read yet: omit model to use the default',
        };
      }),
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function withAbort<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('额度刷新已取消'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('额度刷新已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function refreshOneSlot(usage: SlotUsage, slot: Slot, result: SlotUsageRefreshResult): Promise<void> {
  const before = usage.view(slot.id);
  let after: SlotUsageView;
  try {
    after = await usage.refresh(slot);
  } catch (error) {
    result.failed.push({ slotId: slot.id, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!before.refreshing && before.checkedAt !== null && after.checkedAt === before.checkedAt) {
    result.throttled.push(slot.id);
    return;
  }
  if (after.state === 'unavailable') {
    result.skipped.push({ slotId: slot.id, reason: after.error ?? '该账号不支持订阅额度探测' });
    return;
  }
  const checkedMs = parseTimestamp(after.checkedAt);
  const observedMs = parseTimestamp(after.observedAt);
  if (after.error && (observedMs === null || (checkedMs !== null && checkedMs > observedMs))) {
    result.failed.push({ slotId: slot.id, error: after.error });
    return;
  }
  result.refreshed.push(slot.id);
}

/**
 * Refreshes usage for explicitly requested slot IDs (or `"all"`), reusing SlotUsage's concurrency cap (MAX_PROBES=2),
 * per-slot throttle (15s), and enforcing maintenance mode protection without starting any CLI when blocked.
 */
export async function refreshSlotUsage(
  context: Context,
  userId: string,
  requested: string[],
  signal: AbortSignal,
): Promise<SlotUsageRefreshResult> {
  const unique = [...new Set(requested.map(id => id.trim()).filter(Boolean))];
  const result: SlotUsageRefreshResult = { refreshed: [], throttled: [], skipped: [], failed: [] };
  if (!unique.length) return result;

  if (context.maintenance.isEnabled()) {
    return {
      ...result,
      blockedByMaintenance: true,
      message: `系统正在维护中，已拒绝触发额度探测：${context.maintenance.blockMessage()}`,
    };
  }

  const usage = context.config.usage;
  if (!usage) {
    result.skipped.push(...unique.map(slotId => ({ slotId, reason: '额度服务未启用' })));
    return result;
  }

  const accessible = availableSlots(context.store, userId);
  const byId = new Map(accessible.map(slot => [slot.id, slot]));
  const refreshAll = unique.some(id => id.toLowerCase() === 'all');
  const selected = new Map<string, Slot>();

  if (refreshAll) {
    for (const slot of accessible) selected.set(slot.id, slot);
    for (const id of unique) {
      if (id.toLowerCase() !== 'all' && !byId.has(id)) {
        result.skipped.push({ slotId: id, reason: '槽位不存在或当前用户无权访问' });
      }
    }
  } else {
    for (const id of unique) {
      const slot = byId.get(id);
      if (slot) selected.set(slot.id, slot);
      else result.skipped.push({ slotId: id, reason: '槽位不存在或当前用户无权访问' });
    }
  }

  const probeTargets: Slot[] = [];
  for (const slot of selected.values()) {
    if (slot.status === 'DISABLED') {
      result.skipped.push({ slotId: slot.id, reason: DISABLED_SLOT_NOTE });
    } else if (slot.auth_method === 'token') {
      result.skipped.push({ slotId: slot.id, reason: TOKEN_UNPROBEABLE_NOTE });
    } else {
      probeTargets.push(slot);
    }
  }

  if (probeTargets.length) {
    await withAbort(signal, Promise.all(probeTargets.map(slot => refreshOneSlot(usage, slot, result))));
  }
  return result;
}
