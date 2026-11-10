import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { observeProcessClose, terminateProcess } from '../agent/environment.js';
import { readJsonLines } from '../agent/ndjson.js';
import { RpcClient } from '../agent/rpc.js';
import type { AccountCredentials } from './credentials.js';
import { privateDirectory, readPrivateJson, writePrivateJson } from './credential-files.js';
import { accountIdentifier, credentialPath, type AccountEngine } from './paths.js';
import { ensureClaudeSlotIdentity, readClaudeSlotIdentity } from './claude-identity.js';
import type { ExecutionHost, ExecutionScope } from '../execution/types.js';
import { parseClaudeEvent, parseClaudeUsage, parseCodexEvent, parseCodexRead, type UsageUpdate } from './usage-parsers.js';

export { parseClaudeEvent, parseClaudeUsage, parseCodexEvent, parseCodexRead } from './usage-parsers.js';

export interface UsageWindow {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  limited?: boolean;
  observedAt?: string;
}

export interface SlotUsageView {
  slotId: string;
  state: 'pending' | 'ok' | 'error' | 'unavailable';
  plan: string | null;
  windows: UsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  // Explicit server signal only; never derived from percentages or reset times.
  limited: boolean | null;
  limitingWindow?: string | null;
  observedAt: string | null;
  queriedAt: string | null;
  checkedAt: string | null;
  source: 'query' | 'event' | null;
  stale: boolean;
  refreshing: boolean;
  error: string | null;
}

export interface UsageSlot { id: string; home_dir: string; engine: AccountEngine; status: string }
export interface ResidentUsage { update: UsageUpdate; identity: string | null }

interface Snapshot {
  accountKey: string | null;
  plan: string | null;
  windows: Map<string, UsageWindow>;
  credits: SlotUsageView['credits'];
  limited: boolean | null;
  limitingWindow?: string | null;
  observedAt: number;
  queriedAt?: number;
  source: 'query' | 'event';
  unavailable?: string;
}

interface SlotState { snapshot?: Snapshot; checkedAt?: number; error?: string; failures?: number; inflight?: Promise<void> }

const AUTO_INTERVAL = 60_000;
const FORCE_INTERVAL = 15_000;
const STALE_AFTER = 15 * 60_000;
const PROBE_TIMEOUT = 30_000;
const MAX_PROBES = 2;
// Probes on busy slots must not rotate refresh tokens that a running CLI still holds.
const TOKEN_MARGIN = 15 * 60_000;
const CODEX_REFRESH_AGE = 7 * 24 * 3600_000;
const SAVE_DELAY = 2_000;

function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

async function readJson(file: string, home: string): Promise<any> {
  const content = await readPrivateJson(file, home);
  return content ? JSON.parse(content) : undefined;
}

async function accountKey(home: string, engine: AccountEngine): Promise<string | null> {
  try {
    if (engine === 'codex') {
      const auth = await readJson(credentialPath(home, 'codex'), home);
      const id = auth?.tokens?.account_id ?? (typeof auth?.OPENAI_API_KEY === 'string' ? `key:${auth.OPENAI_API_KEY}` : null);
      return typeof id === 'string' ? digest(`codex:${id}`) : null;
    }
    for (const file of ['.claude.json', join('.claude', '.claude.json')]) {
      const uuid = (await readJson(join(home, file), home))?.oauthAccount?.accountUuid;
      if (typeof uuid === 'string') return digest(`claude:${uuid}`);
    }
    // Without account metadata the refresh token is the best identity, but it rotates; see sameAccount.
    const token = (await readJson(credentialPath(home, 'claude'), home))?.claudeAiOauth?.refreshToken;
    return typeof token === 'string' ? `token:${digest(`claude-token:${token}`)}` : null;
  } catch { return null; }
}

// Cooldowns remain conservative when identity is unreadable or only a rotating token is known.
function sameAccount(cached: string | null, current: string | null): boolean {
  return !cached || !current || cached === current || cached.startsWith('token:') || current.startsWith('token:');
}
export { sameAccount as sameUsageAccount };

function sameSnapshotAccount(cached: string | null, current: string | null): boolean {
  return !!cached && cached === current;
}

function reusableSnapshot(snapshot: Snapshot, identity: string | null): boolean {
  return sameSnapshotAccount(snapshot.accountKey, identity)
    || (!!snapshot.unavailable && snapshot.windows.size === 0 && snapshot.accountKey === identity);
}

interface CachedSnapshot extends Omit<Snapshot, 'windows'> { windows: UsageWindow[] }

type Credential = { kind: 'none' } | { kind: 'apikey' } | { kind: 'oauth'; fresh: boolean };

async function inspectCredential(home: string, engine: AccountEngine): Promise<Credential> {
  const document = await readJson(credentialPath(home, engine), home);
  const deadline = Date.now() + TOKEN_MARGIN;
  if (engine === 'claude') {
    const oauth = document?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string') return { kind: 'none' };
    const hasAccess = oauth.accessToken.length > 0;
    const hasRefresh = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
    if (!hasAccess && !hasRefresh) return { kind: 'none' };
    return { kind: 'oauth', fresh: hasAccess && typeof oauth.expiresAt === 'number' && oauth.expiresAt > deadline };
  }
  const token = document?.tokens?.access_token;
  if (typeof token !== 'string') return typeof document?.OPENAI_API_KEY === 'string' ? { kind: 'apikey' } : { kind: 'none' };
  let expires = 0;
  try { expires = Number(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp) * 1000; }
  catch { /* Unknown expiry is treated as stale. */ }
  const refreshed = Date.parse(String(document?.last_refresh ?? ''));
  return { kind: 'oauth', fresh: expires > deadline && Date.now() - refreshed < CODEX_REFRESH_AGE };
}

interface Probe { execution: ExecutionHost; scope: ExecutionScope; binary: string; home: string }

function probeEnvironment({ execution, scope, home }: Probe): NodeJS.ProcessEnv {
  return { ...execution.baseEnvironment(scope), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), SHELL: '/bin/bash' };
}

async function claudeProbe(probe: Probe): Promise<UsageUpdate> {
  const child = await probe.execution.spawn(probe.binary, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--disable-slash-commands', '--no-session-persistence',
  ], { scope: probe.scope, cwd: probe.home, env: probeEnvironment(probe) });
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

async function codexProbe(probe: Probe): Promise<UsageUpdate> {
  const child = await probe.execution.spawn(probe.binary, ['-c', 'cli_auth_credentials_store="file"', 'app-server'], {
    scope: probe.scope, cwd: probe.home, env: probeEnvironment(probe),
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
  readResident: (slot: UsageSlot) => Promise<ResidentUsage | undefined> = async () => undefined;
  private states = new Map<string, SlotState>();
  private identities = new Map<string, string | null>();
  private running = 0;
  private queue: (() => void)[] = [];
  private readonly root: string;
  private readonly cacheFile: string;
  private saveTimer?: NodeJS.Timeout;
  private saving = Promise.resolve();

  constructor(private config: { dataDir: string; execution: ExecutionHost },
    private credentials: AccountCredentials, private notify: (slotId: string) => void) {
    this.root = join(config.dataDir, 'run', 'usage-probes');
    this.cacheFile = join(config.dataDir, 'cache', 'slot-usage.json');
  }

  // Probe homes hold credential copies; remove any left by an interrupted process. Each slot's directory
  // itself stays, since a slot machine may still have it mounted.
  async init(): Promise<void> {
    await privateDirectory(this.root);
    for (const slot of await readdir(this.root, { withFileTypes: true })) {
      if (!slot.isDirectory()) { await rm(join(this.root, slot.name), { force: true }); continue; }
      for (const entry of await readdir(join(this.root, slot.name))) await rm(join(this.root, slot.name, entry), { recursive: true, force: true });
    }
    await this.load();
  }

  // The last observed usage survives restarts so a failing query still has something to show.
  private async load(): Promise<void> {
    let cached: Record<string, CachedSnapshot>;
    try { cached = JSON.parse(await readFile(this.cacheFile, 'utf8')); }
    catch { return; }
    for (const [slotId, entry] of Object.entries(cached ?? {})) {
      if (!entry || !Array.isArray(entry.windows) || typeof entry.observedAt !== 'number') continue;
      const queriedAt = entry.queriedAt ?? (entry.source === 'query' ? entry.observedAt : undefined);
      this.state(slotId).snapshot = { ...entry, queriedAt, windows: new Map(entry.windows.map(window => [window.key, {
        ...window, observedAt: window.observedAt ?? (queriedAt ? new Date(queriedAt).toISOString() : undefined),
      }])) };
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const cached: Record<string, CachedSnapshot> = {};
      for (const [slotId, { snapshot }] of this.states) {
        if (snapshot) cached[slotId] = { ...snapshot, windows: [...snapshot.windows.values()] };
      }
      this.saving = this.saving.then(() => writePrivateJson(this.cacheFile, JSON.stringify(cached))).catch(() => undefined);
    }, SAVE_DELAY);
    this.saveTimer.unref();
  }

  private state(slotId: string): SlotState {
    let state = this.states.get(slotId);
    if (!state) this.states.set(slotId, state = {});
    return state;
  }

  accountIdentity(slotId: string): string | null {
    return this.identities.has(slotId) ? this.identities.get(slotId)! : this.state(slotId).snapshot?.accountKey ?? null;
  }

  async captureIdentity(slot: Pick<UsageSlot, 'id' | 'home_dir' | 'engine'>): Promise<string | null> {
    const identity = await accountKey(slot.home_dir, slot.engine);
    this.bindIdentity(slot.id, identity);
    return identity;
  }

  private bindIdentity(slotId: string, identity: string | null): void {
    const state = this.state(slotId);
    this.identities.set(slotId, identity);
    // Unknown or rotated identities cannot prove that positive headroom belongs to the current login.
    if (state.snapshot && !reusableSnapshot(state.snapshot, identity)) {
      state.snapshot = undefined;
      state.checkedAt = undefined;
      state.error = undefined;
      state.failures = 0;
      this.scheduleSave();
    }
  }

  async views(slots: UsageSlot[], refresh = false): Promise<Record<string, SlotUsageView>> {
    const result: Record<string, SlotUsageView> = {};
    for (const slot of slots) {
      const state = this.state(slot.id);
      const identity = await accountKey(slot.home_dir, slot.engine);
      this.bindIdentity(slot.id, identity);
      const interval = Math.min(AUTO_INTERVAL * 2 ** (state.failures ?? 0), STALE_AFTER);
      const lastUpdate = Math.max(state.checkedAt ?? 0, state.snapshot?.observedAt ?? 0);
      if (refresh && slot.status !== 'DISABLED' && !state.inflight && Date.now() - lastUpdate >= interval) {
        void this.query(slot);
      }
      result[slot.id] = this.view(slot.id);
    }
    return result;
  }

  async refresh(slot: UsageSlot): Promise<SlotUsageView> {
    const state = this.state(slot.id);
    if (slot.status === 'DISABLED') throw new Error('槽位已停用，不查询额度');
    await this.captureIdentity(slot);
    if (state.inflight) await state.inflight;
    else if (Date.now() - (state.checkedAt ?? 0) >= FORCE_INTERVAL) await this.query(slot);
    return this.view(slot.id);
  }

  view(slotId: string): SlotUsageView {
    const state = this.state(slotId);
    const identity = this.identities.get(slotId);
    const snapshot = state.snapshot && (identity === undefined || reusableSnapshot(state.snapshot, identity))
      ? state.snapshot : undefined;
    const failedLater = !!state.error && (state.checkedAt ?? 0) > (snapshot?.observedAt ?? 0);
    return {
      slotId,
      state: snapshot?.unavailable ? failedLater ? 'error' : 'unavailable' : snapshot ? 'ok' : state.error ? 'error' : 'pending',
      plan: snapshot?.plan ?? null,
      windows: [...(snapshot?.windows.values() ?? [])],
      credits: snapshot?.credits ?? null,
      limited: snapshot?.limited ?? null,
      limitingWindow: snapshot?.limitingWindow ?? null,
      observedAt: snapshot ? new Date(snapshot.observedAt).toISOString() : null,
      queriedAt: snapshot?.queriedAt ? new Date(snapshot.queriedAt).toISOString() : null,
      checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
      source: snapshot?.source ?? null,
      stale: !!snapshot && (Date.now() - snapshot.observedAt > STALE_AFTER || failedLater),
      refreshing: !!state.inflight,
      error: failedLater || !snapshot ? state.error ?? null : snapshot.unavailable ?? null,
    };
  }

  // Live events from running conversations; failures must never affect the conversation itself.
  observe(slot: Pick<UsageSlot, 'id' | 'home_dir' | 'engine'>, kind: 'codex-read' | 'codex-event' | 'claude-event', payload: unknown,
    identity?: string | null): void {
    void (async () => {
      const sourceIdentity = identity === undefined ? await accountKey(slot.home_dir, slot.engine) : identity;
      const update = kind === 'codex-read' ? parseCodexRead(payload) : kind === 'codex-event' ? parseCodexEvent(payload) : parseClaudeEvent(payload);
      if (!update.windows.length && update.limited === undefined && kind !== 'codex-read') return;
      await this.apply(slot, update, kind === 'codex-read' ? 'replace' : 'merge', kind === 'codex-read' ? 'query' : 'event', sourceIdentity);
    })().catch(() => undefined);
  }

  private async apply(slot: Pick<UsageSlot, 'id' | 'home_dir' | 'engine'>, update: UsageUpdate, mode: 'replace' | 'merge',
    source: Snapshot['source'], sourceIdentity?: string | null) {
    const state = this.state(slot.id);
    const currentIdentity = await accountKey(slot.home_dir, slot.engine);
    this.identities.set(slot.id, currentIdentity);
    const changed = sourceIdentity !== undefined && (source === 'event'
      ? sourceIdentity === null || sourceIdentity !== currentIdentity : !sameAccount(sourceIdentity, currentIdentity));
    if (changed) {
      if (state.snapshot && !reusableSnapshot(state.snapshot, currentIdentity)) {
        state.snapshot = undefined;
        this.scheduleSave();
        this.notify(slot.id);
      }
      throw new Error('额度查询期间账号已变化，已丢弃原账号的额度结果');
    }
    // Bind the observation to the account which issued it, never to an account found after the request returned.
    const key = sourceIdentity === undefined ? currentIdentity : sourceIdentity;
    let snapshot = state.snapshot;
    if (snapshot && !sameSnapshotAccount(snapshot.accountKey, key)) snapshot = undefined;
    if (!snapshot || mode === 'replace' || snapshot.unavailable) {
      snapshot = { accountKey: key, plan: null, windows: new Map(), credits: null, limited: null, observedAt: Date.now(), source };
    }
    for (const window of update.windows) {
      const previous = snapshot.windows.get(window.key);
      const observed = { ...window, ...(window.usedPercent !== null ? { observedAt: new Date().toISOString() } : {}) };
      snapshot.windows.set(window.key, previous ? {
        ...previous, ...Object.fromEntries(Object.entries(observed).filter(([, value]) => value !== null && value !== undefined)),
      } : observed);
    }
    if (update.plan !== undefined) snapshot.plan = update.plan ?? snapshot.plan;
    if (update.credits !== undefined) snapshot.credits = update.credits;
    if (update.limited !== undefined) snapshot.limited = update.limited;
    if (update.limitingWindow !== undefined) snapshot.limitingWindow = update.limitingWindow;
    else if (update.limited !== undefined) snapshot.limitingWindow = null;
    if (update.unavailable) snapshot.unavailable = update.unavailable;
    snapshot.observedAt = Date.now();
    // A partial event must not make an old, untouched subscription window look freshly queried.
    if (mode === 'replace' && source === 'query') snapshot.queriedAt = snapshot.observedAt;
    snapshot.source = source;
    snapshot.accountKey = key;
    state.snapshot = snapshot;
    state.failures = 0;
    if (mode === 'replace') state.error = undefined;
    this.scheduleSave();
    this.notify(slot.id);
  }

  private query(slot: UsageSlot): Promise<void> {
    const state = this.state(slot.id);
    state.inflight ??= (async () => {
      this.notify(slot.id);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const sourceIdentity = await accountKey(slot.home_dir, slot.engine);
          const result = await this.limited(async () => await this.readResident(slot)
            ?? { update: await this.probe(slot), identity: sourceIdentity });
          await this.apply(slot, result.update, 'replace', 'query', result.identity);
          const currentIdentity = this.identities.get(slot.id) ?? null;
          // A successful isolated probe may rotate its own token. Re-query under that identity rather than
          // attributing the old request to a new login or treating normal token rotation as a failure.
          if (result.identity === currentIdentity || currentIdentity === null) break;
        }
      } catch (error) {
        state.error = error instanceof Error ? error.message.slice(0, 300) : '额度查询失败';
        state.failures = (state.failures ?? 0) + 1;
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
    const idle = await this.credentials.whileIdle(slot.id, async () => {
      if (slot.engine === 'claude') await ensureClaudeSlotIdentity(this.config.dataDir, slot.id, slot.home_dir);
      return this.isolatedProbe(slot);
    });
    if (idle) return idle.value;
    if (!credential.fresh) throw new Error('槽位正在使用且访问令牌临近刷新，等待对话中的额度事件更新');
    return this.isolatedProbe(slot);
  }

  private async isolatedProbe(slot: UsageSlot): Promise<UsageUpdate> {
    const source = credentialPath(slot.home_dir, slot.engine);
    const original = await readPrivateJson(source, slot.home_dir);
    if (original === undefined) throw new Error('槽位尚未完成登录');
    // Probes run where the slot's conversations run, so the account sees the same machine and egress.
    const directory = join(this.root, accountIdentifier(slot.id));
    const home = join(directory, randomBytes(6).toString('hex'));
    const copy = credentialPath(home, slot.engine);
    const { execution } = this.config;
    const scope: ExecutionScope = { userId: '', slotId: slot.id, paths: [directory] };
    try {
      await privateDirectory(directory);
      await privateDirectory(dirname(copy));
      await writePrivateJson(copy, original);
      if (slot.engine === 'claude') {
        const installation = await readClaudeSlotIdentity(this.config.dataDir, slot.id, slot.home_dir);
        // Share the slot's CLI identity without importing its projects, plugins, or user caches.
        const configurations = await Promise.all(['.claude.json', join('.claude', '.claude.json')]
          .map(file => readJson(join(slot.home_dir, file), slot.home_dir)));
        const identity = Object.assign({}, ...configurations.map(account => Object.fromEntries(
          ['userID', 'oauthAccount', 'hasCompletedOnboarding', 'lastOnboardingVersion']
            .filter(key => account?.[key] !== undefined).map(key => [key, account[key]]))));
        await writePrivateJson(join(home, '.claude', '.claude.json'), JSON.stringify({ ...identity, ...installation }));
      }
      const probe = { execution, scope, home, binary: await execution.binary(scope, slot.engine) };
      const update = await (slot.engine === 'claude' ? claudeProbe(probe) : codexProbe(probe));
      if (await readPrivateJson(source, slot.home_dir) !== original) {
        throw new Error('额度查询期间登录凭据已变化，已丢弃原账号的额度结果');
      }
      return update;
    } finally {
      try {
        const after = await readFile(copy, 'utf8').catch(() => original);
        // A failed usage request can still rotate tokens; preserve them unless the slot changed meanwhile.
        if (after !== original && await readPrivateJson(source, slot.home_dir) === original) await writePrivateJson(source, after);
      } finally { await rm(home, { recursive: true, force: true }); }
    }
  }
}
