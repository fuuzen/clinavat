import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandResult } from '../runtime/types.js';

export type ExecutionKind = 'process' | 'vm';
export type ExecutionBinary = 'claude' | 'codex' | 'mutagen' | 'ssh';

/**
 * What a process may touch. A VM host mounts each path at the same absolute location in the owner's
 * guest, so database records and native transcripts keep the same paths in both modes.
 */
export interface ExecutionScope {
  /** Whose files and keys the process uses; empty for slot-only work such as usage probes. */
  userId: string;
  /** CLI processes run in the slot's own machine, so an account always appears from one machine and one egress. */
  slotId?: string;
  paths: string[];
  /** Files the Hub writes and reads back; a guest must not be able to replace them. */
  readOnlyPaths?: string[];
  /** The administrator's local-host projects always run on the host, with full system access. */
  trusted?: boolean;
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
  /** Added to the execution environment's own variables. */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBytes?: number;
  input?: string;
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
  /** Locale and search path inherited by agent processes; never includes Hub secrets. */
  baseEnvironment(scope: ExecutionScope): NodeJS.ProcessEnv;
  /** The binary as named inside the execution environment; fails when a CLI is known to be missing. */
  binary(scope: ExecutionScope, name: ExecutionBinary): Promise<string>;
  spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams>;
  run(binary: string, args: string[], options: ExecutionRunOptions): Promise<CommandResult>;
  /** Fails while any process still uses the slot home; with a session, only that session's processes count. */
  assertReleased(home: string, sessionId?: string): Promise<void>;
  /**
   * An interactive command for the administrator to run as the Hub's system user, so a slot logs in where its
   * conversations run. `env` holds the slot's home directories.
   */
  loginCommand(slotId: string, home: string, argv: string[], env: Record<string, string>): Promise<string>;
  /** Revokes a user's access to paths that can be handed to another user or moved, such as slot homes. */
  revoke(userId: string, paths: string[]): Promise<void>;
  health(): Promise<ExecutionHealth>;
}
