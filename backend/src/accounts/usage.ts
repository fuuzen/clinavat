import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findExecutable, observeProcessClose, terminateProcess } from '../agent/environment.js';
import { readJsonLines } from '../agent/ndjson.js';
import { RpcClient } from '../agent/rpc.js';
import type { AccountCredentials } from './credentials.js';
import { privateDirectory, readPrivateJson, writePrivateJson } from './credential-files.js';
import { credentialPath, type AccountEngine } from './paths.js';

export interface UsageWindow {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  limited?: boolean;
}

export interface SlotUsageView {
  slotId: string;
  state: 'pending' | 'ok' | 'error' | 'unavailable';
  plan: string | null;
  windows: UsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  // Explicit server signal only; never derived from percentages or reset times.
  limited: boolean | null;
  observedAt: string | null;
  checkedAt: string | null;
  source: 'query' | 'event' | null;
  stale: boolean;
  refreshing: boolean;
  error: string | null;
}

export interface UsageSlot { id: string; home_dir: string; engine: AccountEngine; status: string }

interface UsageUpdate {
  plan?: string | null;
  windows: UsageWindow[];
  credits?: SlotUsageView['credits'];
  limited?: boolean | null;
  unavailable?: string;
}

interface Snapshot {
  accountKey: string | null;
  plan: string | null;
  windows: Map<string, UsageWindow>;
  credits: SlotUsageView['credits'];
  limited: boolean | null;
  observedAt: number;
  source: 'query' | 'event';
  unavailable?: string;
}

interface SlotState { snapshot?: Snapshot; checkedAt?: number; error?: string; inflight?: Promise<void> }

const AUTO_INTERVAL = 60_000;
const FORCE_INTERVAL = 15_000;
const STALE_AFTER = 15 * 60_000;
const PROBE_TIMEOUT = 30_000;
const MAX_PROBES = 2;
// Probes on busy slots must not rotate refresh tokens that a running CLI still holds.
const TOKEN_MARGIN = 15 * 60_000;
const CODEX_REFRESH_AGE = 7 * 24 * 3600_000;

const claudeWindows: [string, string, number | null][] = [
  ['five_hour', '5 小时', 300], ['seven_day', '每周', 10080], ['seven_day_opus', '每周 · Opus', 10080],
  ['seven_day_sonnet', '每周 · Sonnet', 10080], ['seven_day_oauth_apps', '每周 · 第三方应用', 10080],
  ['seven_day_overage_included', '每周 · 含超额模型', 10080], ['overage', '额外用量', null],
];

function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

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
  if (response?.rate_limits_available === false || !limits || typeof limits !== 'object') {
    return { windows: [], plan: response?.subscription_type ?? null, unavailable: '该账号没有 Claude 订阅额度数据（API key 或缺少 profile 授权）' };
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
  return { windows, limited: info?.status === 'rejected' ? true : typeof info?.status === 'string' ? false : undefined };
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

async function readJson(file: string): Promise<any> {
  const content = await readPrivateJson(file);
  return content ? JSON.parse(content) : undefined;
}

async function accountKey(home: string, engine: AccountEngine): Promise<string | null> {
  try {
    if (engine === 'codex') {
      const auth = await readJson(credentialPath(home, 'codex'));
      const id = auth?.tokens?.account_id ?? (typeof auth?.OPENAI_API_KEY === 'string' ? `key:${auth.OPENAI_API_KEY}` : null);
      return typeof id === 'string' ? digest(`codex:${id}`) : null;
    }
    for (const file of ['.claude.json', join('.claude', '.claude.json')]) {
      const uuid = (await readJson(join(home, file)))?.oauthAccount?.accountUuid;
      if (typeof uuid === 'string') return digest(`claude:${uuid}`);
    }
    // Without account metadata the refresh token is the best identity; rotation only causes a fresh query.
    const token = (await readJson(credentialPath(home, 'claude')))?.claudeAiOauth?.refreshToken;
    return typeof token === 'string' ? digest(`claude-token:${token}`) : null;
  } catch { return null; }
}

type Credential = { kind: 'none' } | { kind: 'apikey' } | { kind: 'oauth'; fresh: boolean };

async function inspectCredential(home: string, engine: AccountEngine): Promise<Credential> {
  const document = await readJson(credentialPath(home, engine));
  const deadline = Date.now() + TOKEN_MARGIN;
  if (engine === 'claude') {
    const oauth = document?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string') return { kind: 'none' };
    return { kind: 'oauth', fresh: typeof oauth.expiresAt === 'number' && oauth.expiresAt > deadline };
  }
  const token = document?.tokens?.access_token;
  if (typeof token !== 'string') return typeof document?.OPENAI_API_KEY === 'string' ? { kind: 'apikey' } : { kind: 'none' };
  let expires = 0;
  try { expires = Number(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp) * 1000; }
  catch { /* Unknown expiry is treated as stale. */ }
  const refreshed = Date.parse(String(document?.last_refresh ?? ''));
  return { kind: 'oauth', fresh: expires > deadline && Date.now() - refreshed < CODEX_REFRESH_AGE };
}

function probeEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return { ...environment, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), SHELL: '/bin/bash' };
}

async function claudeProbe(binary: string, home: string): Promise<UsageUpdate> {
  const child = spawn(binary, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--disable-slash-commands', '--no-session-persistence',
  ], { cwd: home, env: probeEnvironment(home), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  let closeLines: (() => void) | undefined;
  try {
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude 额度查询超时')), PROBE_TIMEOUT);
      const settle = (error?: Error, value?: unknown) => { clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const lines = readJsonLines(child.stdout, event => {
        if (event.type !== 'control_response' || event.response?.request_id !== 'usage') return;
        if (event.response.subtype !== 'success') {
          const message = String(event.response.error || 'Claude 额度查询失败');
          settle(new Error(message.includes('not supported') ? '当前 Claude Code 版本不支持额度查询' : message));
        } else settle(undefined, event.response.response);
      }, error => settle(error));
      closeLines = lines.close;
      child.once('error', error => settle(error));
      child.once('close', () => settle(new Error('Claude 在返回额度前退出')));
      child.stdin.once('error', error => settle(error));
      for (const request of [{ request_id: 'initialize', request: { subtype: 'initialize' } },
        { request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }]) {
        child.stdin.write(JSON.stringify({ type: 'control_request', ...request }) + '\n');
      }
    });
    return parseClaudeUsage(response);
  } finally {
    closeLines?.();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}

async function codexProbe(binary: string, home: string): Promise<UsageUpdate> {
  const child = spawn(binary, ['-c', 'cli_auth_credentials_store="file"', 'app-server'], {
    cwd: home, env: probeEnvironment(home), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  const rpc = new RpcClient(child, async message => {
    if (message.id !== undefined && message.method) rpc.send({ id: message.id, error: { code: -32601, message: 'Usage probe only' } });
  }, () => undefined);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'clinavat_usage', title: 'Clinavat Usage', version: '0.1.0' }, capabilities: { experimentalApi: true },
    }, PROBE_TIMEOUT);
    rpc.send({ method: 'initialized', params: {} });
    return parseCodexRead(await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, PROBE_TIMEOUT));
  } finally {
    rpc.close();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}

export class SlotUsage {
  private states = new Map<string, SlotState>();
  private running = 0;
  private queue: (() => void)[] = [];
  private readonly root: string;

  constructor(private config: { dataDir: string; claudeBinary: string; codexBinary: string },
    private credentials: AccountCredentials, private notify: (slotId: string) => void) {
    this.root = join(config.dataDir, 'run', 'usage-probes');
  }

  // Probe homes hold credential copies; remove any left by an interrupted process.
  async init(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }

  private state(slotId: string): SlotState {
    let state = this.states.get(slotId);
    if (!state) this.states.set(slotId, state = {});
    return state;
  }

  async views(slots: UsageSlot[], refresh = false): Promise<Record<string, SlotUsageView>> {
    const result: Record<string, SlotUsageView> = {};
    for (const slot of slots) {
      const state = this.state(slot.id);
      if (state.snapshot && state.snapshot.accountKey !== await accountKey(slot.home_dir, slot.engine)) {
        state.snapshot = undefined;
        state.checkedAt = undefined;
      }
      if (refresh && slot.status !== 'DISABLED' && !state.inflight && Date.now() - (state.checkedAt ?? 0) >= AUTO_INTERVAL) {
        void this.query(slot);
      }
      result[slot.id] = this.view(slot.id);
    }
    return result;
  }

  async refresh(slot: UsageSlot): Promise<SlotUsageView> {
    const state = this.state(slot.id);
    if (slot.status === 'DISABLED') throw new Error('槽位已停用，不查询额度');
    if (state.inflight) await state.inflight;
    else if (Date.now() - (state.checkedAt ?? 0) >= FORCE_INTERVAL) await this.query(slot);
    return this.view(slot.id);
  }

  view(slotId: string): SlotUsageView {
    const state = this.state(slotId);
    const snapshot = state.snapshot;
    const failedLater = !!state.error && (state.checkedAt ?? 0) > (snapshot?.observedAt ?? 0);
    return {
      slotId,
      state: snapshot?.unavailable ? 'unavailable' : snapshot ? 'ok' : state.error ? 'error' : 'pending',
      plan: snapshot?.plan ?? null,
      windows: [...(snapshot?.windows.values() ?? [])],
      credits: snapshot?.credits ?? null,
      limited: snapshot?.limited ?? null,
      observedAt: snapshot ? new Date(snapshot.observedAt).toISOString() : null,
      checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
      source: snapshot?.source ?? null,
      stale: !!snapshot && (Date.now() - snapshot.observedAt > STALE_AFTER || failedLater),
      refreshing: !!state.inflight,
      error: snapshot?.unavailable ?? (failedLater || !snapshot ? state.error ?? null : null),
    };
  }

  // Live events from running conversations; failures must never affect the conversation itself.
  observe(slot: Pick<UsageSlot, 'id' | 'home_dir' | 'engine'>, kind: 'codex-read' | 'codex-event' | 'claude-event', payload: unknown): void {
    void (async () => {
      const update = kind === 'codex-read' ? parseCodexRead(payload) : kind === 'codex-event' ? parseCodexEvent(payload) : parseClaudeEvent(payload);
      if (!update.windows.length && update.limited === undefined && kind !== 'codex-read') return;
      await this.apply(slot, update, kind === 'codex-read' ? 'replace' : 'merge', kind === 'codex-read' ? 'query' : 'event');
    })().catch(() => undefined);
  }

  private async apply(slot: Pick<UsageSlot, 'id' | 'home_dir' | 'engine'>, update: UsageUpdate, mode: 'replace' | 'merge', source: Snapshot['source']) {
    const state = this.state(slot.id);
    const key = await accountKey(slot.home_dir, slot.engine);
    let snapshot = state.snapshot;
    if (snapshot && snapshot.accountKey !== key) snapshot = undefined;
    if (!snapshot || mode === 'replace' || snapshot.unavailable) {
      snapshot = { accountKey: key, plan: null, windows: new Map(), credits: null, limited: null, observedAt: Date.now(), source };
    }
    for (const window of update.windows) {
      const previous = snapshot.windows.get(window.key);
      snapshot.windows.set(window.key, previous ? {
        ...previous, ...Object.fromEntries(Object.entries(window).filter(([, value]) => value !== null && value !== undefined)),
      } : window);
    }
    if (update.plan !== undefined) snapshot.plan = update.plan ?? snapshot.plan;
    if (update.credits !== undefined) snapshot.credits = update.credits;
    if (update.limited !== undefined) snapshot.limited = update.limited;
    if (update.unavailable) snapshot.unavailable = update.unavailable;
    snapshot.observedAt = Date.now();
    snapshot.source = source;
    state.snapshot = snapshot;
    if (mode === 'replace') state.error = undefined;
    this.notify(slot.id);
  }

  private query(slot: UsageSlot): Promise<void> {
    const state = this.state(slot.id);
    state.inflight ??= (async () => {
      this.notify(slot.id);
      try {
        await this.apply(slot, await this.limited(() => this.probe(slot)), 'replace', 'query');
      } catch (error) {
        state.error = error instanceof Error ? error.message.slice(0, 300) : '额度查询失败';
      } finally {
        state.checkedAt = Date.now();
        state.inflight = undefined;
        this.notify(slot.id);
      }
    })();
    return state.inflight;
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_PROBES) await new Promise<void>(resolve => this.queue.push(resolve));
    this.running++;
    try { return await task(); }
    finally { this.running--; this.queue.shift()?.(); }
  }

  private async probe(slot: UsageSlot): Promise<UsageUpdate> {
    const credential = await inspectCredential(slot.home_dir, slot.engine);
    if (credential.kind === 'none') throw new Error('槽位尚未完成登录');
    if (credential.kind === 'apikey') return { windows: [], unavailable: 'API key 账号没有订阅额度窗口' };
    // Idle slots are paused for the probe, so a token refresh can be written back safely.
    const idle = await this.credentials.whileIdle(slot.id, () => this.isolatedProbe(slot));
    if (idle) return idle.value;
    if (!credential.fresh) throw new Error('槽位正在使用且访问令牌临近刷新，等待对话中的额度事件更新');
    return this.isolatedProbe(slot);
  }

  private async isolatedProbe(slot: UsageSlot): Promise<UsageUpdate> {
    const source = credentialPath(slot.home_dir, slot.engine);
    const original = await readFile(source, 'utf8');
    const home = join(this.root, `${slot.id}-${randomBytes(6).toString('hex')}`);
    const copy = credentialPath(home, slot.engine);
    try {
      await privateDirectory(dirname(copy));
      await writePrivateJson(copy, original);
      const binary = await findExecutable(slot.engine === 'claude' ? this.config.claudeBinary : this.config.codexBinary);
      const update = await (slot.engine === 'claude' ? claudeProbe(binary, home) : codexProbe(binary, home));
      const after = await readFile(copy, 'utf8').catch(() => original);
      // Keep a rotated refresh token only if nobody changed the slot credential meanwhile.
      if (after !== original && await readFile(source, 'utf8') === original) await writePrivateJson(source, after);
      return update;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
