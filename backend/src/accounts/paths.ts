import { join } from 'node:path';

export type AccountEngine = 'claude' | 'codex';

export function accountIdentifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('账号运行目录标识无效');
  return value;
}

export function userRuntimeHome(dataDir: string, userId: string): string {
  return join(dataDir, 'users', accountIdentifier(userId), 'runtime');
}

export function sessionRuntimeHome(dataDir: string, userId: string, sessionId: string): string {
  return join(dataDir, 'users', accountIdentifier(userId), 'sessions', accountIdentifier(sessionId), 'runtime');
}

export function credentialPath(home: string, engine: AccountEngine): string {
  return engine === 'codex' ? join(home, '.codex', 'auth.json') : join(home, '.claude', '.credentials.json');
}

export function credentialJournalPath(dataDir: string, userId: string, engine: AccountEngine): string {
  return join(dataDir, 'accounts', 'leases', `${accountIdentifier(userId)}.${engine}.json`);
}
