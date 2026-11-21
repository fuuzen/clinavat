import { join } from 'node:path';
import { accountIdentifier } from '../paths.js';
import { engineProfiles, type AgentEngine } from '../../agent/engines.js';

export function sessionStateDirectories(engine: AgentEngine): readonly string[] {
  return engineProfiles[engine].sessionDirectories;
}

export function sessionStateFiles(engine: AgentEngine): readonly string[] {
  return engineProfiles[engine].sessionFiles;
}

export function userSessionStateRoot(dataDir: string, userId: string, engine: AgentEngine): string {
  return join(dataDir, 'users', accountIdentifier(userId), 'engine-state', engine);
}

export function engineDirectory(home: string, engine: AgentEngine): string {
  return join(home, engineProfiles[engine].configDirectory);
}
