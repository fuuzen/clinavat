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
  credentials: AccountCredentials;
  execution: ExecutionHost;
  usage?: SlotUsage;
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
    resume_interrupted?: boolean;
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
}

export interface AgentRun {
  process: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  stop(): void;
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
  output(content: string): Promise<void>;
  update(fields: Parameters<AgentCallbacks['updateSession']>[1]): Promise<void>;
  approve(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ApprovalDecision>;
  ask(questions: UserInputQuestion[], signal?: AbortSignal): Promise<UserInputAnswers | null>;
  verifyShell(): Promise<void>;
}
