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
  engine: "claude" | "codex";
  status: "IDLE" | "RATE_LIMITED" | "DISABLED";
  allowed_user_ids?: string[];
  max_concurrent_users: 1;
  in_use: boolean;
  in_use_by_you: boolean;
  active_user_id?: string | null;
  home_dir?: string;
  credential_revision: number;
  updated_at: string;
}

export interface DevHost {
  id: string;
  kind?: "local" | "ssh";
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
  local_path: string;
  path_mode: "auto" | "direct" | "bwrap" | "symlink";
  execution_mode: "local" | "direct" | "bwrap" | "symlink" | null;
  sync_status: string;
}

export interface Session {
  id: string;
  project_id: string;
  engine: "claude" | "codex";
  slot_id: string | null;
  title: string;
  status: string;
  updated_at: string;
  model?: string | null;
  reasoning_effort?: string | null;
  permission_mode?: PermissionMode;
  agent_mode?: AgentMode;
  role_preset?: RolePreset;
}

export type PermissionMode = "manual" | "accept-edits" | "auto" | "full-access" | "yolo";
export type AgentMode = "normal" | "plan";
export type RolePreset = "default" | "reviewer" | "architect";
export interface AgentBehavior {
  agentMode: AgentMode;
  rolePreset: RolePreset;
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
  paused_at?: string | null;
  paused_ms?: number;
  status: "running" | "pausing" | "paused" | "completed" | "interrupted" | "error";
  items: ActivityItem[];
}

export interface Overview {
  user: User;
  slots: Slot[];
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

export interface UsageWindow {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  limited?: boolean;
}

export interface SlotUsage {
  slotId: string;
  state: "pending" | "ok" | "error" | "unavailable";
  plan: string | null;
  windows: UsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  limited: boolean | null;
  observedAt: string | null;
  checkedAt: string | null;
  source: "query" | "event" | null;
  stale: boolean;
  refreshing: boolean;
  error: string | null;
}

export interface SyncScanEntry {
  path: string;
  type: "file" | "directory";
  bytes: number;
  files: number;
  tracked: boolean | null;
}

export interface SyncScan {
  remotePath: string;
  totalBytes: number;
  totalFiles: number;
  entries: SyncScanEntry[];
  truncated: boolean;
}

export interface ProjectUsage {
  mirrorBytes: number | null;
  backupBytes: number;
}

export interface GitState {
  branch: string;
  status: string;
  diff: string;
}
