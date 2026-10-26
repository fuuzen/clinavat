import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AgentConfig {
  dataDir: string;
  claudeBinary: string;
  codexBinary: string;
  approvalTimeoutMs: number;
}

export interface AgentContext {
  user: { id: string };
  slot: { id: string; home_dir: string; cli_types: string[] };
  project: { id: string; local_path: string; remote_path: string; sync_name: string };
  session: {
    id: string;
    engine: 'claude' | 'codex';
    native_session_id?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
    turn_id?: string;
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
}

export interface AgentRun {
  process: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  stop(): void;
}

export interface RunServices {
  config: AgentConfig;
  context: AgentContext;
  event(type: string, payload: unknown): void;
  output(content: string): Promise<void>;
  update(fields: Parameters<AgentCallbacks['updateSession']>[1]): Promise<void>;
  approve(tool: string, input: Record<string, unknown>): Promise<ApprovalDecision>;
  verifyShell(): Promise<void>;
}
