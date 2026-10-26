import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, type Slot, type User } from './models.js';

export class Store {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'cc-pool.sqlite'));
    chmodSync(join(dataDir, 'cc-pool.sqlite'), 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS account_slots (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, cli_types TEXT NOT NULL,
        assigned_user_id TEXT UNIQUE REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('IDLE','ASSIGNED','RATE_LIMITED','DISABLED')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK((status='IDLE' AND assigned_user_id IS NULL) OR status IN ('DISABLED','RATE_LIMITED') OR (status='ASSIGNED' AND assigned_user_id IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dev_hosts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
        host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DISCONNECTED', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        dev_host_id TEXT NOT NULL REFERENCES dev_hosts(id), name TEXT NOT NULL,
        remote_path TEXT NOT NULL, local_path TEXT NOT NULL UNIQUE, sync_name TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'CREATING', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(dev_host_id,remote_path)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id), engine TEXT NOT NULL CHECK(engine IN ('claude','codex')),
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', native_session_id TEXT, jsonl_file_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        status TEXT NOT NULL DEFAULT 'running', items TEXT NOT NULL DEFAULT '[]'
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
      CREATE INDEX IF NOT EXISTS events_user ON events(user_id,id);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
      CREATE INDEX IF NOT EXISTS turns_session ON session_turns(session_id,started_at);
    `);
    const sessionColumns = this.all<{ name: string }>('PRAGMA table_info(sessions)');
    for (const column of ['model', 'reasoning_effort']) {
      if (!sessionColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
    const hostColumns = this.all<{ name: string }>('PRAGMA table_info(dev_hosts)');
    for (const [column, type] of [['jump_host', 'TEXT'], ['jump_port', 'INTEGER'], ['jump_username', 'TEXT']]) {
      if (!hostColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE dev_hosts ADD COLUMN ${column} ${type}`);
    }
    const interruptedAt = new Date().toISOString();
    this.run("UPDATE session_turns SET status='interrupted',completed_at=?,duration_ms=MAX(0,CAST((julianday(?)-julianday(started_at))*86400000 AS INTEGER)) WHERE status='running'", interruptedAt, interruptedAt);
    this.run("UPDATE sessions SET status='interrupted' WHERE status IN ('running','waiting')");
    this.run("UPDATE dev_hosts SET status='DISCONNECTED' WHERE status='CONNECTED'");
    this.run("UPDATE approvals SET status='expired', reason='服务重新启动' WHERE status='pending'");
    this.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now());
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
  assignSlot(userId: string): Slot | null {
    return this.transaction(() => this.assignAvailableSlot(userId));
  }
  createUser(input: Omit<User, 'created_at'>, requireEmpty = false) {
    return this.transaction(() => {
      if (requireEmpty && this.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, '平台已初始化');
      if (this.get('SELECT id FROM users WHERE username=?', input.username)) throw new HttpError(409, '用户名已存在');
      this.run('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', input.id, input.username, input.password_hash, input.role);
      const user = this.get<User>('SELECT * FROM users WHERE id=?', input.id)!;
      return { user, slot: this.assignAvailableSlot(user.id) };
    });
  }
  private assignAvailableSlot(userId: string): Slot | null {
    const assigned = this.get<Slot>('SELECT * FROM account_slots WHERE assigned_user_id=?', userId);
    if (assigned) return assigned;
    const idle = this.get<Slot>("SELECT * FROM account_slots WHERE status='IDLE' AND assigned_user_id IS NULL ORDER BY id LIMIT 1");
    if (!idle) return null;
    this.run("UPDATE account_slots SET assigned_user_id=?,status='ASSIGNED',updated_at=datetime('now') WHERE id=?", userId, idle.id);
    return this.get<Slot>('SELECT * FROM account_slots WHERE id=?', idle.id)!;
  }
  close() { this.db.close(); }
}
