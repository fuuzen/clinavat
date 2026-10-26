export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  created_at: string;
  ssh_public_key?: string;
}

export interface Slot {
  id: string;
  label: string;
  cli_types: string[];
  status: string;
  assigned_user_id?: string | null;
  home_dir?: string;
}

export interface DevHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  status: string;
  fingerprint?: string;
  jump_host?: string | null;
  jump_port?: number | null;
  jump_username?: string | null;
}

export interface Project {
  id: string;
  name: string;
  dev_host_id: string;
  remote_path: string;
  sync_status: string;
}

export interface Session {
  id: string;
  project_id: string;
  engine: "claude" | "codex";
  title: string;
  status: string;
  updated_at: string;
  model?: string | null;
  reasoning_effort?: string | null;
}

export interface AgentSelection {
  model: string | null;
  reasoningEffort: string | null;
}

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: { value: string; label: string }[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface Approval {
  id: string;
  session_id: string;
  tool: string;
  input: unknown;
  status: string;
  created_at: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  status?: string;
}

export interface ActivityItem {
  id: string;
  kind: "text" | "reasoning" | "tool";
  text?: string;
  tool?: ToolEvent;
  final?: boolean;
}

export interface Turn {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id?: string | null;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  status: "running" | "completed" | "interrupted" | "error";
  items: ActivityItem[];
}

export interface Overview {
  user: User;
  slot: Slot | null;
  hosts: DevHost[];
  projects: Project[];
  sessions: Session[];
}

export interface PoolEvent {
  type: string;
  sessionId?: string;
  payload?: Record<string, unknown> | string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface GitState {
  branch: string;
  status: string;
  diff: string;
}
