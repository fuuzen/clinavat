import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HttpError, type User } from './models.js';
import { ensureLocalHost } from './local-host.js';

export function databasePath(dataDirectory: string): string {
  return join(resolve(dataDirectory), 'clinavat.sqlite');
}

export class Store {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const filename = databasePath(dataDir);
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS account_slots (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE,
        engine TEXT NOT NULL CHECK(engine IN ('claude','codex')),
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
      CREATE TABLE IF NOT EXISTS dev_hosts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
        host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DISCONNECTED', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        jump_host TEXT, jump_port INTEGER, jump_username TEXT,
        kind TEXT NOT NULL DEFAULT 'ssh' CHECK(kind IN ('ssh','local'))
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        dev_host_id TEXT NOT NULL REFERENCES dev_hosts(id), name TEXT NOT NULL,
        remote_path TEXT NOT NULL, local_path TEXT NOT NULL UNIQUE, sync_name TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'CREATING', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        path_mode TEXT NOT NULL DEFAULT 'auto', execution_mode TEXT,
        UNIQUE(dev_host_id,remote_path)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id), engine TEXT NOT NULL CHECK(engine IN ('claude','codex')),
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', native_session_id TEXT, jsonl_file_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        model TEXT, reasoning_effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'manual', slot_id TEXT,
        agent_mode TEXT NOT NULL DEFAULT 'normal', role_preset TEXT NOT NULL DEFAULT 'default'
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
      CREATE TABLE IF NOT EXISTS deferred_questions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        questions TEXT NOT NULL, created_at TEXT NOT NULL, deferred_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS events_user ON events(user_id,id);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
      CREATE INDEX IF NOT EXISTS turns_session ON session_turns(session_id,started_at);
      CREATE INDEX IF NOT EXISTS slot_access_user ON slot_user_access(user_id,slot_id);
      CREATE UNIQUE INDEX IF NOT EXISTS local_host_user ON dev_hosts(user_id) WHERE kind='local';
      CREATE INDEX IF NOT EXISTS deferred_questions_session ON deferred_questions(session_id,deferred_at);
    `);
    this.addColumn('sessions', 'slot_mode', "TEXT NOT NULL DEFAULT 'manual' CHECK(slot_mode IN ('manual','auto'))");
    // Question settings left NULL follow the next level: conversation, then its user, then the site.
    for (const table of ['users', 'sessions']) {
      this.addColumn(table, 'question_mode', "TEXT CHECK(question_mode IN ('skip','defer'))");
      this.addColumn(table, 'question_timeout_ms', 'INTEGER');
    }
    if (!this.all<{ name: string }>('PRAGMA table_info(slot_quota_limits)').some(column => column.name === 'account_key')) {
      this.db.exec('ALTER TABLE slot_quota_limits ADD COLUMN account_key TEXT');
    }
    if (!this.all<{ name: string; pk: number }>('PRAGMA table_info(slot_quota_limits)').some(column => column.name === 'account_key' && column.pk)) {
      this.transaction(() => this.db.exec(`
        CREATE TABLE slot_quota_limits_by_account (
          slot_id TEXT NOT NULL REFERENCES account_slots(id) ON DELETE CASCADE,
          credential_revision INTEGER NOT NULL, window_key TEXT NOT NULL,
          resets_at TEXT NOT NULL, account_key TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY(slot_id,account_key,window_key)
        );
        INSERT INTO slot_quota_limits_by_account(slot_id,credential_revision,window_key,resets_at,account_key,recorded_at)
          SELECT slot_id,MAX(credential_revision),window_key,MAX(resets_at),COALESCE(account_key,''),MAX(recorded_at)
          FROM slot_quota_limits GROUP BY slot_id,COALESCE(account_key,''),window_key;
        DROP TABLE slot_quota_limits;
        ALTER TABLE slot_quota_limits_by_account RENAME TO slot_quota_limits;
      `));
    }
    const interruptedAt = new Date().toISOString();
    this.run(`UPDATE session_turns SET status='interrupted',completed_at=?,paused_at=NULL,
      duration_ms=CASE WHEN status='paused' AND duration_ms IS NOT NULL THEN duration_ms
        ELSE MAX(0,CAST((julianday(?)-julianday(started_at))*86400000 AS INTEGER)-paused_ms) END
      WHERE status IN ('running','pausing','paused')`, interruptedAt, interruptedAt);
    this.run("UPDATE sessions SET status='interrupted' WHERE status IN ('running','waiting','pausing','paused')");
    this.run("UPDATE dev_hosts SET status='DISCONNECTED' WHERE status='CONNECTED' AND kind='ssh'");
    for (const user of this.all<User>("SELECT * FROM users WHERE role='admin'")) ensureLocalHost(this, user.id);
    this.run("UPDATE approvals SET status='expired', reason='服务重新启动' WHERE status='pending'");
    this.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now());
  }
  private addColumn(table: string, column: string, definition: string) {
    if (this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(item => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createUser(input: Omit<User, 'created_at'>, requireEmpty = false) {
    return this.transaction(() => {
      if (requireEmpty && this.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, '平台已初始化');
      if (this.get('SELECT id FROM users WHERE username=?', input.username)) throw new HttpError(409, '用户名已存在');
      this.run('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', input.id, input.username, input.password_hash, input.role);
      const user = this.get<User>('SELECT * FROM users WHERE id=?', input.id)!;
      if (user.role === 'admin') ensureLocalHost(this, user.id);
      return { user, slots: [] };
    });
  }
  close() { this.db.close(); }
}
