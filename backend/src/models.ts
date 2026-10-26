export interface User {
  id: string; username: string; password_hash: string; role: 'admin' | 'user'; created_at: string;
}
export interface Slot {
  id: string; label: string; home_dir: string; cli_types: string;
  assigned_user_id: string | null; status: 'IDLE' | 'ASSIGNED' | 'RATE_LIMITED' | 'DISABLED';
  updated_at: string;
}
export interface Host {
  id: string; user_id: string; name: string; host: string; port: number; username: string;
  status: string; created_at: string;
  jump_host?: string | null; jump_port?: number | null; jump_username?: string | null;
}
export interface Project {
  id: string; user_id: string; dev_host_id: string; name: string; remote_path: string;
  local_path: string; sync_name: string; sync_status: string; created_at: string;
}
export interface Session {
  id: string; project_id: string; user_id: string; engine: 'claude' | 'codex';
  title: string; status: string; native_session_id: string | null;
  jsonl_file_path: string | null; created_at: string; updated_at: string;
  model: string | null; reasoning_effort: string | null;
}
export interface PoolEvent { type: string; sessionId?: string; payload: unknown }
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
