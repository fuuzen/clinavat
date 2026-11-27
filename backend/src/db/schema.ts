import type { DatabaseSync } from 'node:sqlite';
import { engineCheck } from '../agent/engines.js';

export const superReadModeColumn = "TEXT NOT NULL DEFAULT 'overview' CHECK(super_read_mode IN ('off','overview','full'))";

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS account_slots (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE,
      engine TEXT NOT NULL ${engineCheck},
      status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('IDLE','RATE_LIMITED','DISABLED')),
      credential_revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS slot_user_access (
      slot_id TEXT NOT NULL REFERENCES account_slots(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(slot_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_access (
      id INTEGER PRIMARY KEY CHECK(id=1), public_urls TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
    );
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maintenance_mode (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      enabled_by TEXT,
      enabled_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dev_hosts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DISCONNECTED', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      jump_host TEXT, jump_port INTEGER, jump_username TEXT,
      kind TEXT NOT NULL DEFAULT 'ssh' CHECK(kind IN ('ssh','local','client'))
    );
    CREATE TABLE IF NOT EXISTS client_devices (
      id TEXT PRIMARY KEY,
      dev_host_id TEXT NOT NULL UNIQUE REFERENCES dev_hosts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      arch TEXT NOT NULL,
      os_version TEXT NOT NULL DEFAULT '',
      default_shell TEXT NOT NULL DEFAULT '',
      homedir TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS client_devices_user ON client_devices(user_id);
    CREATE TABLE IF NOT EXISTS dev_host_approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dev_host_id TEXT,
      hop TEXT NOT NULL CHECK(hop IN ('target','jump')),
      hostname TEXT NOT NULL,
      pinned_ip TEXT NOT NULL,
      port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      decided_by TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      dev_host_id TEXT NOT NULL REFERENCES dev_hosts(id), name TEXT NOT NULL,
      remote_path TEXT NOT NULL, local_path TEXT NOT NULL UNIQUE, sync_name TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'CREATING', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      path_mode TEXT NOT NULL DEFAULT 'auto', execution_mode TEXT,
      client_mode TEXT NOT NULL DEFAULT 'direct', vm_path TEXT,
      UNIQUE(dev_host_id,remote_path)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), engine TEXT NOT NULL ${engineCheck},
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', native_session_id TEXT, jsonl_file_path TEXT,
      last_context_tokens INTEGER NOT NULL DEFAULT 0, last_context_window INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT, reasoning_effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'manual', slot_id TEXT,
      agent_mode TEXT NOT NULL DEFAULT 'normal', role_preset TEXT NOT NULL DEFAULT 'default',
      super_read_mode ${superReadModeColumn}
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session_turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'running', items TEXT NOT NULL DEFAULT '[]',
      slot_id TEXT, credential_revision INTEGER, paused_at TEXT, paused_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS slot_quota_limits (
      slot_id TEXT NOT NULL REFERENCES account_slots(id) ON DELETE CASCADE,
      credential_revision INTEGER NOT NULL, window_key TEXT NOT NULL,
      resets_at TEXT NOT NULL, account_key TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(slot_id,account_key,window_key)
    );
    CREATE TABLE IF NOT EXISTS session_input_queue (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      inputs TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), tool TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS gateway_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS execution_machines (
      name TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('workspace','slot')), owner_id TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE, hostname TEXT, machine_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(kind, owner_id)
    );
    CREATE TABLE IF NOT EXISTS question_defaults (
      id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('skip','defer')), timeout_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_agent_defaults (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, engine TEXT NOT NULL ${engineCheck},
      model TEXT, reasoning_effort TEXT, PRIMARY KEY(user_id,engine)
    );
    CREATE TABLE IF NOT EXISTS machine_resources (
      kind TEXT PRIMARY KEY CHECK(kind IN ('slot','workspace')), cpu INTEGER NOT NULL, memory_mib INTEGER NOT NULL,
      disk_gib INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), refresh_interval_ms INTEGER NOT NULL, stale_after_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deferred_questions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      questions TEXT NOT NULL, created_at TEXT NOT NULL, deferred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_id TEXT NOT NULL, session_id TEXT, turn_id TEXT, engine TEXT NOT NULL ${engineCheck},
      model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      cost_usd REAL, cost_source TEXT CHECK(cost_source IN ('cli','prices')),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS model_price_snapshot (
      id INTEGER PRIMARY KEY CHECK(id=1), prices TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS model_price_overrides (
      model TEXT PRIMARY KEY, input REAL NOT NULL, cache_read REAL, cache_write REAL, output REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS message_images (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orchestration_settings (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
    -- The user's agent roster: named child agents a master can start by name.
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      engine TEXT NOT NULL ${engineCheck}, slot_id TEXT, model TEXT, reasoning_effort TEXT,
      access TEXT NOT NULL DEFAULT 'read' CHECK(access IN ('read','write')), instructions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id,name)
    );
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','interrupted','error')),
      report TEXT, notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)), wave TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_master ON agent_tasks(master_session_id,status);
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      stage INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, acceptance TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','verifying','blocked','completed','cancelled')),
      assigned_agent TEXT, depends_on TEXT, summary TEXT, review_rounds INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(master_session_id,stage,seq)
    );
    CREATE TABLE IF NOT EXISTS project_memories (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL, content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(project_id,key)
    );
    -- A discussion among child agents, hosted by the conversation that receives its record: a master, or a moderator.
    CREATE TABLE IF NOT EXISTS discussions (
      id TEXT PRIMARY KEY, host_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      topic TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('council','debate','review')),
      rounds INTEGER NOT NULL, round INTEGER NOT NULL DEFAULT 0, started_by TEXT NOT NULL CHECK(started_by IN ('master','user')),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','stopped','error')), detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS discussions_host ON discussions(host_session_id,created_at);
    CREATE TABLE IF NOT EXISTS discussion_statements (
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, round INTEGER NOT NULL,
      status TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(discussion_id,session_id,round)
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_child ON agent_tasks(child_session_id,status);
    CREATE INDEX IF NOT EXISTS message_images_session ON message_images(session_id);
    CREATE INDEX IF NOT EXISTS events_user ON events(user_id,id);
    CREATE INDEX IF NOT EXISTS token_usage_user ON token_usage(user_id,recorded_at);
    CREATE INDEX IF NOT EXISTS token_usage_recorded ON token_usage(recorded_at);
    CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
    CREATE INDEX IF NOT EXISTS turns_session ON session_turns(session_id,started_at);
    CREATE INDEX IF NOT EXISTS slot_access_user ON slot_user_access(user_id,slot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS local_host_user ON dev_hosts(user_id) WHERE kind='local';
    CREATE INDEX IF NOT EXISTS dev_host_approvals_user_target ON dev_host_approvals(user_id,pinned_ip,port,status);
    CREATE INDEX IF NOT EXISTS dev_host_approvals_host ON dev_host_approvals(user_id,dev_host_id,status);
    CREATE INDEX IF NOT EXISTS dev_host_approvals_status ON dev_host_approvals(status,requested_at);
    CREATE INDEX IF NOT EXISTS deferred_questions_session ON deferred_questions(session_id,deferred_at);
    CREATE TABLE IF NOT EXISTS session_btw_exchanges (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','error','cancelled')),
      error TEXT,
      engine TEXT NOT NULL ${engineCheck},
      model TEXT,
      slot_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_btw_exchanges_session ON session_btw_exchanges(session_id, created_at);
  `);
}
