import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandResult } from '../runtime/types.js';

export type ExecutionKind = 'process' | 'vm';

/**
 * Host paths a process may touch. A VM host mounts each path at the same absolute location in the
 * owner's guest, so database records and native transcripts keep the same paths in both modes.
 */
export interface ExecutionScope {
  userId: string;
  paths: string[];
}

export interface ExecutionSpawnOptions {
  scope: ExecutionScope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: 'pipe' | 'ignore';
}

export interface ExecutionRunOptions {
  scope: ExecutionScope;
  cwd?: string;
  /** Defaults to the execution environment's own variables. */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBytes?: number;
  input?: string;
}

export interface ExecutionBinaries {
  claude: string;
  codex: string;
  mutagen: string;
  ssh: string;
}

export interface ExecutionHealth {
  kind: ExecutionKind;
  claude: boolean;
  codex: boolean;
  mutagen: boolean;
  ssh: boolean;
}

/** Where users' CLIs, shells and synchronization processes run. */
export interface ExecutionHost {
  readonly kind: ExecutionKind;
  readonly binaries: ExecutionBinaries;
  /** Locale and search path inherited by agent processes; never includes Hub secrets. */
  baseEnvironment(): NodeJS.ProcessEnv;
  /** Resolves a binary inside the execution environment and fails when it is missing. */
  resolveBinary(userId: string, binary: string): Promise<string>;
  spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams>;
  run(binary: string, args: string[], options: ExecutionRunOptions): Promise<CommandResult>;
  /** Fails while any process still uses the slot home; with a session, only that session's processes count. */
  assertReleased(home: string, sessionId?: string): Promise<void>;
  /** Revokes a user's access to paths that can be handed to another user, such as slot homes. */
  revoke(userId: string, paths: string[]): Promise<void>;
  health(): Promise<ExecutionHealth>;
}
