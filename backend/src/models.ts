import type { PermissionMode } from './agent/permissions.js';
import type { AgentMode, RolePreset } from './agent/session-settings.js';

export interface User {
  id: string; username: string; password_hash: string; role: 'admin' | 'user'; created_at: string;
}
export interface Slot {
  id: string; label: string; home_dir: string; engine: 'claude' | 'codex';
  status: 'IDLE' | 'RATE_LIMITED' | 'DISABLED';
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
}
export interface Session {
  id: string; project_id: string; user_id: string; engine: 'claude' | 'codex'; slot_id: string | null;
  title: string; status: string; native_session_id: string | null;
  jsonl_file_path: string | null; created_at: string; updated_at: string;
  model: string | null; reasoning_effort: string | null;
  permission_mode: PermissionMode;
  agent_mode: AgentMode;
  role_preset: RolePreset;
}
export interface PoolEvent { type: string; sessionId?: string; payload: unknown }
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
