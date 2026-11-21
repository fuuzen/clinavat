import { join } from 'node:path';
import { engineProfiles, type AgentEngine } from '../agent/engines.js';

export function accountIdentifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('账号运行目录标识无效');
  return value;
}

export function credentialPath(home: string, engine: AgentEngine): string {
  return join(home, engineProfiles[engine].credentialFile);
}
