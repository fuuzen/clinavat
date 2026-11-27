import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandResult } from '../runtime/types.js';
import type { MachineKind } from './machine-plan.js';

export type ExecutionKind = 'process' | 'vm';
export type ExecutionBinary = 'claude' | 'codex' | 'agy' | 'mutagen' | 'ssh';

export interface ExecutionMount {
  source: string;
  /** Absolute POSIX path inside the guest; defaults to `source`. */
  target?: string;
  readonly?: boolean;
}

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
  /** Additional mounts that may map a host source directory to a distinct guest target path. */
  mounts?: ExecutionMount[];
}

export interface ExecutionSpawnOptions {
  scope: ExecutionScope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Variables that must never appear on a command line, such as account tokens; requires a piped stdin. */
  secrets?: Record<string, string>;
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
  agy: boolean;
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
  /** Ensures the user's workspace machine is booted and ready to run commands (no-op in process mode). */
  ensureWorkspace(userId: string): Promise<void>;
  /** Fails while any process still uses the slot home; with a session, only that session's processes count. */
  assertReleased(home: string, sessionId?: string): Promise<void>;
  /**
   * An interactive command for the administrator to run as the Hub's system user, so a slot logs in where its
   * conversations run. `env` holds the slot's home directories.
   */
  loginCommand(slotId: string, home: string, argv: string[], env: Record<string, string>): Promise<string>;
  /** Revokes a user's access to paths that can be handed to another user or moved, such as slot homes. */
  revoke(userId: string, paths: string[]): Promise<void>;
  /** The user whose files a slot's machine still holds; running as anyone else hands the machine over first. */
  slotOccupant(slotId: string): Promise<string | undefined>;
  /**
   * Stops a user's workspace or a slot's machine, or with `remove` deletes it. Its address and identity stay reserved:
   * the gateway binds egress by address, and a reused address would inherit another account's egress.
   */
  retire(kind: MachineKind, owner: string, remove: boolean): Promise<void>;
  health(): Promise<ExecutionHealth>;
}
