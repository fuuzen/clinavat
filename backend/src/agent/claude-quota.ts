import type { QuotaFailure } from './types.js';

const subscriptionWindows = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export class ClaudeQuotaTracker {
  private failure: QuotaFailure | undefined;

  observeAssistant(event: Record<string, unknown>): void {
    this.reset();
    if (event.api_error !== 'usage_limit_reached') return;
    const info = record(record(event.api_error_params)?.rate_limit_info);
    if (!info || info.status !== 'rejected' || info.isUsingOverage !== false
      || info.overageInUse === true || info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning'
      || typeof info.rateLimitType !== 'string' || !subscriptionWindows.has(info.rateLimitType)) return;
    // A reset time is required so an unrecognized or permanent refusal cannot trigger repeated switches.
    if (typeof info.resetsAt !== 'number' || !Number.isFinite(info.resetsAt)) return;
    const resetsAt = new Date(info.resetsAt * 1000);
    if (!Number.isFinite(resetsAt.getTime()) || resetsAt.getTime() <= Date.now()) return;
    this.failure = { window: info.rateLimitType, resetsAt: resetsAt.toISOString() };
  }

  finish(result: Record<string, unknown>): QuotaFailure | undefined {
    const failure = this.failure;
    this.reset();
    // Generic rate_limit errors also cover paid credits; both structured error frames must agree.
    if (result.is_error !== true || result.api_error_status !== 429 || result.api_error !== 'usage_limit_reached'
      || !failure?.resetsAt || Date.parse(failure.resetsAt) <= Date.now()) return undefined;
    return failure;
  }

  reset(): void {
    this.failure = undefined;
  }
}
