import type { SlotUsageView, UsageWindow } from './usage.js';

export interface UsageUpdate {
  plan?: string | null;
  windows: UsageWindow[];
  credits?: SlotUsageView['credits'];
  limited?: boolean | null;
  limitingWindow?: string | null;
  unavailable?: string;
}

const claudeWindows: [string, string, number | null][] = [
  ['five_hour', '5 小时', 300], ['seven_day', '每周', 10080], ['seven_day_opus', '每周 · Opus', 10080],
  ['seven_day_sonnet', '每周 · Sonnet', 10080], ['seven_day_oauth_apps', '每周 · 第三方应用', 10080],
  ['seven_day_overage_included', '每周 · 含超额模型', 10080], ['overage', '额外用量', null],
];

function percent(value: unknown, scale = 1): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * scale * 10) / 10 : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function durationLabel(minutes: number | null): string {
  if (minutes === 300) return '5 小时';
  if (minutes === 10080) return '每周';
  if (!minutes) return '额度窗口';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function parseClaudeUsage(response: any): UsageUpdate {
  const limits = response?.rate_limits;
  if (response?.rate_limits_available === false) {
    return { windows: [], plan: response?.subscription_type ?? null, unavailable: '该账号没有 Claude 订阅额度数据（API key 或缺少 profile 授权）' };
  }
  // The CLI also returns null on request failures for accounts eligible to read usage.
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('Claude 额度查询暂时失败（可能被限流或连接异常），请稍后重试');
  }
  const windows: UsageWindow[] = [];
  for (const [key, label, windowMinutes] of claudeWindows) {
    const window = limits[key];
    if (!window || typeof window !== 'object') continue;
    windows.push({ key, label, windowMinutes, usedPercent: percent(window.utilization), resetsAt: timestamp(window.resets_at) });
  }
  for (const model of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (typeof model?.display_name !== 'string') continue;
    windows.push({ key: `model:${model.display_name}`, label: `每周 · ${model.display_name}`, windowMinutes: 10080,
      usedPercent: percent(model.utilization), resetsAt: timestamp(model.resets_at) });
  }
  if (limits.extra_usage?.is_enabled === true) {
    windows.push({ key: 'extra_usage', label: '额外用量（本月）', windowMinutes: null,
      usedPercent: percent(limits.extra_usage.utilization), resetsAt: null });
  }
  return { windows, plan: typeof response.subscription_type === 'string' ? response.subscription_type : null };
}

// rate_limit_event reports utilization as a 0-1 fraction and reset times as epoch seconds.
export function parseClaudeEvent(info: any): UsageUpdate {
  const windows: UsageWindow[] = [];
  const labels = new Map(claudeWindows.map(([key, label, minutes]) => [key, { label, minutes }]));
  const add = (key: string, window: any) => {
    const known = labels.get(key);
    if (!known) return;
    windows.push({ key, label: known.label, windowMinutes: known.minutes, usedPercent: percent(window.utilization, 100),
      resetsAt: timestamp(window.resetsAt), ...(typeof window.status === 'string' ? { limited: window.status === 'rejected' } : {}) });
  };
  if (info?.unifiedWindows && typeof info.unifiedWindows === 'object') {
    for (const [key, window] of Object.entries(info.unifiedWindows)) if (window && typeof window === 'object') add(key, window);
  }
  if (typeof info?.rateLimitType === 'string' && !windows.some(window => window.key === info.rateLimitType)) add(info.rateLimitType, info);
  const limitingWindow = typeof info?.rateLimitType === 'string' && labels.has(info.rateLimitType) ? info.rateLimitType : null;
  const limited = info?.status === 'rejected' ? true : typeof info?.status === 'string' ? false : undefined;
  const limiting = windows.find(window => window.key === limitingWindow);
  // unifiedWindows carries utilization without status; the top-level refusal still applies to that window.
  if (limiting && limited !== undefined) limiting.limited = limited;
  return { windows, limited, ...(limited !== undefined ? { limitingWindow: limited ? limitingWindow : null } : {}) };
}

function codexBucket(snapshot: any, prefix: boolean): UsageWindow[] {
  const id = typeof snapshot?.limitId === 'string' ? snapshot.limitId : 'codex';
  const name = typeof snapshot?.limitName === 'string' ? snapshot.limitName : id;
  return (['primary', 'secondary'] as const).flatMap(slot => {
    const window = snapshot?.[slot];
    if (!window || typeof window !== 'object') return [];
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null;
    return [{ key: `${id}:${slot}`, label: `${prefix ? `${name} · ` : ''}${durationLabel(minutes)}`, windowMinutes: minutes,
      usedPercent: percent(window.usedPercent), resetsAt: timestamp(window.resetsAt) }];
  });
}

function codexCredits(snapshot: any): SlotUsageView['credits'] | undefined {
  const credits = snapshot?.credits;
  if (!credits || typeof credits !== 'object' || credits.hasCredits === false) return undefined;
  return { balance: typeof credits.balance === 'string' ? credits.balance : null, unlimited: credits.unlimited === true };
}

export function parseCodexRead(response: any): UsageUpdate {
  const buckets = Object.values(response?.rateLimitsByLimitId ?? {}).filter(Boolean);
  const list = buckets.length ? buckets : response?.rateLimits ? [response.rateLimits] : [];
  const primary = response?.rateLimits ?? list[0];
  const reached = list.some((bucket: any) => typeof bucket?.rateLimitReachedType === 'string');
  return {
    windows: list.flatMap((bucket: any) => codexBucket(bucket, list.length > 1 && bucket?.limitId !== 'codex')),
    plan: typeof primary?.planType === 'string' ? primary.planType : null,
    credits: codexCredits(primary) ?? null,
    limited: response?.ordinaryUsageAllowed === false || reached ? true : response?.ordinaryUsageAllowed === true ? false : null,
  };
}

// account/rateLimits/updated is sparse: absent values keep what was observed before.
export function parseCodexEvent(params: any): UsageUpdate {
  const snapshot = params?.rateLimits;
  return {
    windows: codexBucket(snapshot, typeof snapshot?.limitId === 'string' && snapshot.limitId !== 'codex'),
    ...(typeof snapshot?.planType === 'string' ? { plan: snapshot.planType } : {}),
    ...(codexCredits(snapshot) ? { credits: codexCredits(snapshot) } : {}),
    ...(typeof snapshot?.rateLimitReachedType === 'string' ? { limited: true } : {}),
  };
}

