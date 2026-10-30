import { join } from 'node:path';
import { accountIdentifier, type AccountEngine } from '../paths.js';

const directories: Record<AccountEngine, readonly string[]> = {
  claude: ['projects', 'file-history', 'todos', 'tasks', 'plans', 'paste-cache'],
  codex: ['sessions', 'archived_sessions', 'thread-writer-locks'],
};

export function sessionStateDirectories(engine: AccountEngine): readonly string[] {
  return directories[engine];
}

export function sessionStateFiles(engine: AccountEngine): readonly string[] {
  return engine === 'codex' ? ['goals_1.sqlite'] : [];
}

export function userSessionStateRoot(dataDir: string, userId: string, engine: AccountEngine): string {
  return join(dataDir, 'users', accountIdentifier(userId), 'engine-state', engine);
}

export function engineDirectory(home: string, engine: AccountEngine): string {
  return join(home, engine === 'claude' ? '.claude' : '.codex');
}
