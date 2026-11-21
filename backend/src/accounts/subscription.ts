import { join } from 'node:path';
import { readPrivateJson } from './credential-files.js';
import { credentialPath } from './paths.js';
import type { AgentEngine } from '../agent/engines.js';

/** What a slot's own login files say about its subscription; nothing here is fetched from the provider. */
export interface SlotSubscription {
  /** The provider's plan identifier, such as `max` or `plus`. */
  plan: string | null;
  /** Claude's rate-limit tier, which tells Max 5x from Max 20x. */
  tier: string | null;
  startedAt: string | null;
  /** End of the paid period; Codex states it, Claude does not. */
  expiresAt: string | null;
  /** When the provider last confirmed the subscription for this login. */
  verifiedAt: string | null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

async function readDocument(home: string, file: string): Promise<Record<string, any> | undefined> {
  const content = await readPrivateJson(file, home);
  return content ? JSON.parse(content) : undefined;
}

async function claudeSubscription(home: string): Promise<SlotSubscription | null> {
  const oauth = (await readDocument(home, credentialPath(home, 'claude')))?.claudeAiOauth;
  let account: Record<string, unknown> | undefined;
  for (const file of ['.claude.json', join('.claude', '.claude.json')]) {
    account ??= (await readDocument(home, join(home, file)))?.oauthAccount;
  }
  const subscription = { plan: text(oauth?.subscriptionType), tier: text(oauth?.rateLimitTier),
    startedAt: timestamp(account?.subscriptionCreatedAt), expiresAt: null, verifiedAt: null };
  return subscription.plan || subscription.startedAt ? subscription : null;
}

// The ID token carries ChatGPT's subscription claims as of its last refresh.
async function codexSubscription(home: string): Promise<SlotSubscription | null> {
  const token = text((await readDocument(home, credentialPath(home, 'codex')))?.tokens?.id_token);
  if (!token) return null;
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())?.['https://api.openai.com/auth'];
  if (!claims || typeof claims !== 'object') return null;
  return { plan: text(claims.chatgpt_plan_type), tier: null, startedAt: timestamp(claims.chatgpt_subscription_active_start),
    expiresAt: timestamp(claims.chatgpt_subscription_active_until), verifiedAt: timestamp(claims.chatgpt_subscription_last_checked) };
}

const subscriptions: Record<AgentEngine, (home: string) => Promise<SlotSubscription | null>> = {
  claude: claudeSubscription,
  codex: codexSubscription,
};

export async function readSubscription(home: string, engine: AgentEngine): Promise<SlotSubscription | null> {
  try { return await subscriptions[engine](home); }
  catch { return null; }
}

/** How a slot's CLI authenticates and when that ends, as far as its login files state it. */
export interface SlotLogin {
  method: 'oauth' | 'token' | 'apikey' | 'none';
  /** A fixed end, known only for long-lived tokens, from the validity the administrator entered. */
  expiresAt: string | null;
  /** The short-lived access token of a browser login, which the CLI renews by itself while the login lasts. */
  accessExpiresAt: string | null;
  /** When the CLI last renewed the access token; only Codex records it. */
  refreshedAt: string | null;
}

const noLogin: SlotLogin = { method: 'none', expiresAt: null, accessExpiresAt: null, refreshedAt: null };

/** Reads each CLI's login file. */
const logins: Record<AgentEngine, (document: Record<string, any> | undefined) => SlotLogin> = {
  claude(document) {
    const oauth = document?.claudeAiOauth;
    return typeof oauth?.accessToken === 'string' ? { ...noLogin, method: 'oauth', accessExpiresAt: timestamp(oauth.expiresAt) } : noLogin;
  },
  codex(document) {
    const token = text(document?.tokens?.access_token);
    if (!token) return text(document?.OPENAI_API_KEY) ? { ...noLogin, method: 'apikey' } : noLogin;
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return { ...noLogin, method: 'oauth', accessExpiresAt: timestamp(claims?.exp), refreshedAt: timestamp(document?.last_refresh) };
  },
};

export async function readLogin(home: string, engine: AgentEngine): Promise<SlotLogin> {
  try { return logins[engine](await readDocument(home, credentialPath(home, engine))); }
  catch { return noLogin; }
}
