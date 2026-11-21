import { join } from 'node:path';
import type { ExecutionBinary } from '../execution/types.js';
import type { PermissionMode } from './permissions.js';

/**
 * The CLIs a slot can hold. What differs between them is stated here, or in a `Record<AgentEngine, …>` next to
 * the code that needs it, so adding an engine is a compile error everywhere it still needs an answer.
 */
export const agentEngines = ['claude', 'codex'] as const;
export type AgentEngine = typeof agentEngines[number];

export interface EngineProfile {
  label: string;
  binary: ExecutionBinary;
  /** The CLI's own directory in a slot home. */
  configDirectory: string;
  /** The account's login, relative to the slot home. */
  credentialFile: string;
  /** Native conversation storage in the CLI's directory. It belongs to the user, so it moves with them between slots. */
  sessionDirectories: readonly string[];
  sessionFiles: readonly string[];
  /** Entries of the CLI's directory that hold or guard the account; they never move with a user's profile. */
  protectedEntries: readonly string[];
  /** Account files whose temporary copies and backups the CLI leaves beside them, in the home and in the CLI's directory. */
  artifactBases: { home: readonly string[]; engine: readonly string[] };
  permissionModes: readonly PermissionMode[];
  /** The Hub may choose the account and switch it when the subscription quota runs out. */
  automaticSlot: boolean;
  /** A slot may log in with a long-lived token instead of a browser login. */
  setupToken: boolean;
  rolePresets: boolean;
  goal: boolean;
  /** The login an administrator runs in the slot's machine. */
  login(home: string): { argv: string[]; env: Record<string, string> };
}

export const engineProfiles: Record<AgentEngine, EngineProfile> = {
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    configDirectory: '.claude',
    credentialFile: '.claude/.credentials.json',
    sessionDirectories: ['projects', 'file-history', 'todos', 'tasks', 'plans', 'paste-cache'],
    sessionFiles: [],
    protectedEntries: ['.credentials.json', '.claude.json', '.oauth_refresh.lock', '.oauth_refresh.lock.owner',
      '.credentials.json.lock', '.credentials.json.lock.owner', '.claude.json.lock', '.claude.json.lock.owner',
      '.storage-write', '.storage-write.lock'],
    artifactBases: { home: ['.claude.json'], engine: ['.credentials.json', '.claude.json'] },
    permissionModes: ['manual', 'accept-edits', 'auto', 'full-access', 'yolo'],
    automaticSlot: true,
    setupToken: true,
    rolePresets: false,
    goal: false,
    login: home => ({ argv: ['claude', 'auth', 'login'], env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') } }),
  },
  codex: {
    label: 'Codex',
    binary: 'codex',
    configDirectory: '.codex',
    credentialFile: '.codex/auth.json',
    sessionDirectories: ['sessions', 'archived_sessions', 'thread-writer-locks'],
    sessionFiles: ['goals_1.sqlite'],
    protectedEntries: ['auth.json', 'auth.json.lock', 'auth.json.lock.owner', '.auth.json.lock', '.auth-refresh.lock'],
    artifactBases: { home: [], engine: ['auth.json'] },
    permissionModes: ['manual', 'auto', 'full-access', 'yolo'],
    automaticSlot: false,
    setupToken: false,
    rolePresets: true,
    goal: true,
    login: home => ({ argv: ['codex', '-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
      env: { HOME: home, CODEX_HOME: join(home, '.codex') } }),
  },
};

export function isAgentEngine(value: unknown): value is AgentEngine {
  return agentEngines.includes(value as AgentEngine);
}

/** The column constraint of every table that records an engine. */
export const engineCheck = `CHECK(engine IN (${agentEngines.map(engine => `'${engine}'`).join(',')}))`;
