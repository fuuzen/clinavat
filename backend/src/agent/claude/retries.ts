import { randomUUID } from 'node:crypto';
import type { RunServices } from '../types.js';

// `error` in an api_retry event is the CLI's category; network failures carry no status and come as `unknown`.
const reasons: Record<string, string> = {
  rate_limit: '请求被限流', overloaded: 'API 服务过载', server_error: 'API 服务器出错',
  authentication_failed: '认证失败', cloud_credential_error: '云服务凭据无效',
};

/**
 * The CLI retries a failed API request by itself and reports each attempt only as an `api_retry` event. One process
 * entry per outage shows the attempts and then how they ended, so a turn that waited on the API keeps that record.
 */
export class ClaudeRetries {
  private id = '';
  private reason = '';
  private attempts = 0;

  constructor(private readonly services: Pick<RunServices, 'event'>) {}

  observe(event: Record<string, unknown>): void {
    const status = typeof event.error_status === 'number' ? event.error_status : undefined;
    this.reason = (reasons[String(event.error)] ?? (status ? 'API 请求失败' : '无法连接 API 服务器')) + (status ? `（HTTP ${status}）` : '');
    this.attempts = Number(event.attempt) || this.attempts + 1;
    this.id ||= `retry:${randomUUID()}`;
    const limit = Number(event.max_retries) ? `/${Number(event.max_retries)}` : '';
    const wait = Math.ceil(Number(event.retry_delay_ms) / 1000);
    this.show(`${this.reason}，${wait > 0 ? `${wait} 秒后` : ''}进行第 ${this.attempts}${limit} 次重试`);
  }

  /** The model answered again, or the turn ended while requests were still failing. */
  settle(outcome: 'recovered' | 'failed' | 'stopped' = 'recovered'): void {
    if (!this.id) return;
    this.show(outcome === 'recovered' ? `${this.reason}，第 ${this.attempts} 次重试后已恢复`
      : outcome === 'failed' ? `${this.reason}，重试 ${this.attempts} 次后仍失败` : `${this.reason}，已停止重试`);
    this.id = '';
    this.attempts = 0;
  }

  private show(text: string): void {
    this.services.event('activity', { id: this.id, kind: 'notice', text });
  }
}
