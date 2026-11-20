import { HttpError } from '../models.js';
import type { MachinePlan } from './machine-plan.js';
import type { ExecutionScope } from './types.js';

export function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (timezone.length <= 128 && /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) {
    try { return new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone; }
    catch { /* Unsupported zones must not fall through to the guest's local timezone. */ }
  }
  throw new HttpError(400, `无效的 IANA 时区：${timezone.slice(0, 128)}`);
}

export function defaultTimezone(): string {
  if (process.env.TZ) {
    try { return normalizeTimezone(process.env.TZ); } catch { /* POSIX TZ values have no matching guest zone file. */ }
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try { return normalizeTimezone(local); }
  catch { return 'UTC'; }
}

export function supportedTimezones(): string[] {
  return ['UTC', ...Intl.supportedValuesOf('timeZone')];
}

export function guestEnvironment(plan: MachinePlan, scope?: Pick<ExecutionScope, 'slotId'>): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/home/clinavat', USER: 'clinavat', LOGNAME: 'clinavat', SHELL: '/bin/bash',
    TZ: scope?.slotId ? plan.get('slot', scope.slotId)?.timezone ?? defaultTimezone() : process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export const missingTimezoneData = 65;

export const timezoneScript = String.raw`set -eu
zone="/usr/share/zoneinfo/$1"
[ -f "$zone" ] || { echo "guest timezone data unavailable: $1" >&2; exit ${missingTimezoneData}; }
ln -sfn -- "$zone" /etc/localtime
printf '%s\n' "$1" > /etc/timezone
`;

/** The caller serializes this with the slot's boot, mount and retirement operations. */
export async function saveSlotTimezone(plan: MachinePlan, slotId: string, name: string, timezone: string | null,
  apply: (timezone: string) => Promise<boolean>): Promise<{ applied: boolean }> {
  const normalized = timezone === null ? null : normalizeTimezone(timezone);
  const previous = plan.ensure('slot', slotId, name).timezone;
  try {
    const applied = await apply(normalized ?? defaultTimezone());
    plan.setTimezone(slotId, normalized);
    return { applied };
  } catch (error) {
    // A failed guest update or database write must not leave the guest using an unsaved choice.
    await apply(previous ?? defaultTimezone()).catch((rollback: Error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}；恢复原时区失败：${rollback.message}`);
    });
    throw error;
  }
}
