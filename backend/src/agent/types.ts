import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AccountCredentials } from '../accounts/credentials.js';
import type { SlotUsage } from '../accounts/usage.js';
import type { UserInputAnswers, UserInputQuestion } from './user-input.js';
import type { RunControl } from './run-control.js';
import type { CodexGoal, CodexGoalChange } from './codex-goal.js';
import type { ExecutionHost } from '../execution/types.js';

export interface AgentConfig {
  dataDir: string;
  claudeBinary: string;
  codexBinary: string;
  approvalTimeoutMs: number;
  runtimeIdleMs: number;
  credentials: AccountCredentials;
  execution: ExecutionHost;
  usage?: SlotUsage;
  /** Refuses a run whose slot has no egress yet, instead of letting the CLI fail on network errors. */
  egress?: { assertBound(slotId: string): Promise<void> };
}

export interface AgentContext {
  user: { id: string };
  runtime_home: string;
  runtime_kind?: 'conversation' | 'probe';
  slot: { id: string; home_dir: string; engine: 'claude' | 'codex'; credential_revision: number; updated_at?: string };
  project: {
    id: string; local_path: string; remote_path: string; sync_name: string;
    execution_mode?: 'local' | 'direct' | 'bwrap' | 'symlink' | null;
  };
  session: {
    id: string;
    engine: 'claude' | 'codex';
    native_session_id?: string | null;
    jsonl_file_path?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
    permission_mode?: string | null;
    agent_mode?: string | null;
    role_preset?: string | null;
    command?: 'compact';
    turn_id?: string;
    goal?: { action: 'create' | 'resume'; objective?: string };
  };
}

export interface AgentEvent {
  type: string;
  sessionId: string;
  payload: unknown;
}

export interface ApprovalRequest {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface AgentCallbacks {
  event(event: AgentEvent): void;
  saveMessage(sessionId: string, role: string, content: string): void | Promise<void>;
  updateSession(sessionId: string, fields: {
    native_session_id?: string;
    status?: string;
    jsonl_file_path?: string;
  }): void | Promise<void>;
  approval(request: ApprovalRequest): Promise<ApprovalDecision>;
  flushWorkspace(sessionId: string): Promise<void>;
  /** Persists a user message and returns its ID. */
  saveUserMessage(sessionId: string, content: string): string;
  /** Records a new turn for a saved message, or for a turn the CLI began after a background task. Returns the turn ID. */
  beginTurn(sessionId: string, origin: TurnOrigin, authorization: TurnAuthorization): string;
}

export type TurnOrigin = { messageId: string } | { summary: string };

export interface TurnAuthorization { slotId: string; credentialRevision: number }
export type InputMode = 'steer' | 'queue' | 'interrupt';
export interface QueuedInput { id: string; content: string; prompt: string; queuedAt: string; messageId?: string }
/** A background task of the running CLI. */
export interface RunTask { id: string; description: string; type: string }
export interface TurnOutcome { status: 'completed' | 'interrupted' | 'error'; error?: string; output?: string }

/** One resident CLI process; a conversation runs any number of turns in it. */
export interface AgentRun {
  process: ChildProcessWithoutNullStreams;
  /** Settles when the process has ended. */
  completion: Promise<void>;
  stop(): void;
  startTurn(prompt: string): Promise<void>;
  /** Adds input to the active turn; false when there is none to join. `messageId` names the persisted message. */
  steer(text: string, messageId: string): Promise<boolean>;
  interruptTurn(): Promise<void>;
  /** No turn, task or goal needs this process any more. */
  isIdle(): boolean;
  /** Lets the process finish on its own; ends it after a short grace period. */
  close(): void;
  tasks(): RunTask[];
  stopTask(taskId: string): Promise<void>;
  goal?: {
    get(): Promise<CodexGoal | null>;
    set(change: CodexGoalChange): Promise<CodexGoal | null>;
  };
}

export interface RunServices {
  config: AgentConfig;
  context: AgentContext;
  control: RunControl;
  event(type: string, payload: unknown): void;
  update(fields: Parameters<AgentCallbacks['updateSession']>[1]): Promise<void>;
  approve(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ApprovalDecision>;
  ask(questions: UserInputQuestion[], signal?: AbortSignal): Promise<UserInputAnswers | null>;
  verifyShell(): Promise<void>;
  /** Must be called synchronously with the end of the turn's output, before any event of a later turn. */
  turnEnded(outcome: TurnOutcome): void;
  /** The CLI began a turn by itself. */
  automaticTurn(origin: TurnOrigin): void;
  /** Something changed that can make the process idle or keep it from being idle. */
  activityChanged(): void;
}
