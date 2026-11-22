import type { PermissionMode } from './agent/permissions.js';
import type { AgentMode, QuestionMode, RolePreset } from './agent/session-settings.js';
import type { AgentEngine } from './agent/engines.js';

export interface User {
  id: string; username: string; password_hash: string; role: 'admin' | 'user'; created_at: string;
  suspended_at?: string | null;
  question_mode?: QuestionMode | null; question_timeout_ms?: number | null;
}
export interface Slot {
  id: string; label: string; home_dir: string; engine: AgentEngine;
  status: 'IDLE' | 'RATE_LIMITED' | 'DISABLED';
  /** `token` slots authenticate with a long-lived `claude setup-token` token instead of a browser login. */
  auth_method: 'oauth' | 'token';
  token_expires_at: string | null;
  members_can_reset: 0 | 1;
  /** The saved model catalog as JSON, and when it was read from the slot's CLI. */
  model_catalog: string | null;
  model_catalog_at: string | null;
  credential_revision: number;
  updated_at: string;
}
export interface Host {
  id: string; user_id: string; name: string; host: string; port: number; username: string;
  kind: 'ssh' | 'local';
  status: string; created_at: string;
  jump_host?: string | null; jump_port?: number | null; jump_username?: string | null;
}
export interface Project {
  id: string; user_id: string; dev_host_id: string; name: string; remote_path: string;
  local_path: string; sync_name: string; sync_status: string; created_at: string;
  path_mode: 'auto' | 'direct' | 'bwrap' | 'symlink';
  execution_mode: 'direct' | 'bwrap' | 'symlink' | 'local' | null;
  sync_rules: string | null;
  sync_skipped_links?: string | null;
  /** Set on a child agent's worktree project: its master project, and where its checkout lives. */
  parent_project_id?: string | null;
  /** The repository root on the development host (or the host) that the worktree belongs to. */
  worktree_repo?: string | null;
  /** The worktree's root; the project's remote path may be a directory inside it. */
  worktree_path?: string | null;
  worktree_branch?: string | null;
  /** The commit the branch started from. */
  worktree_base?: string | null;
  /** 'changes' when its branch has commits to merge, 'conflict' after a merge stopped, 'resolving' while the user resolves one. */
  worktree_state?: 'changes' | 'conflict' | 'resolving' | null;
  worktree_conflicts?: string | null;
  worktree_setup?: string | null;
}
export interface Session {
  id: string; project_id: string; user_id: string; engine: AgentEngine; slot_id: string | null;
  slot_mode: 'manual' | 'auto';
  title: string; status: string; native_session_id: string | null;
  jsonl_file_path: string | null; created_at: string; updated_at: string;
  model: string | null; reasoning_effort: string | null;
  permission_mode: PermissionMode;
  agent_mode: AgentMode;
  role_preset: RolePreset;
  question_mode: QuestionMode | null;
  question_timeout_ms: number | null;
  /** Archived conversations are hidden from the workspace list and accept no input until restored. */
  archived_at: string | null;
  forked_from_session_id: string | null;
  forked_from_turn_id: string | null;
  /** The source's native session and the point to fork it at, used by the branch's first run. */
  fork_native_id: string | null;
  fork_native_anchor: string | null;
  /** The master conversation that started this one as a child agent; NULL for conversations the user started. */
  parent_session_id: string | null;
  agent_name: string | null;
  agent_access: 'read' | 'write' | null;
  /** Whether the agent may start and direct child agents through the Hub's tools. */
  orchestration: 0 | 1;
  /** A child agent's working directory relative to its project's root; NULL for the root. */
  agent_directory: string | null;
  agent_isolation: 'shared' | 'worktree' | null;
}
export interface PoolEvent { type: string; sessionId?: string; payload: unknown }
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
