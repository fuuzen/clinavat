import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { HttpError, type User } from './models.js';
import { ensureLocalHost } from './local-host.js';
import { databasePath } from './storage-paths.js';

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
        id TEXT PRIMARY KEY, label TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, cli_types TEXT NOT NULL,
        assigned_user_id TEXT UNIQUE REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('IDLE','ASSIGNED','RATE_LIMITED','DISABLED')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK((status='IDLE' AND assigned_user_id IS NULL) OR status IN ('DISABLED','RATE_LIMITED') OR (status='ASSIGNED' AND assigned_user_id IS NOT NULL))
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
      CREATE TABLE IF NOT EXISTS gateway_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL, detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS events_user ON events(user_id,id);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
      CREATE INDEX IF NOT EXISTS turns_session ON session_turns(session_id,started_at);
    `);
    const slotColumns = this.all<{ name: string }>('PRAGMA table_info(account_slots)');
    if (!slotColumns.some(item => item.name === 'credential_revision')) {
      this.db.exec('ALTER TABLE account_slots ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0');
    }
    const sessionColumns = this.all<{ name: string }>('PRAGMA table_info(sessions)');
    for (const column of ['model', 'reasoning_effort']) {
      if (!sessionColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
    if (!sessionColumns.some(item => item.name === 'slot_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN slot_id TEXT');
    }
    const turnColumns = this.all<{ name: string }>('PRAGMA table_info(session_turns)');
    for (const [column, type] of [['slot_id', 'TEXT'], ['credential_revision', 'INTEGER'],
      ['paused_at', 'TEXT'], ['paused_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!turnColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE session_turns ADD COLUMN ${column} ${type}`);
    }
    if (!sessionColumns.some(item => item.name === 'permission_mode')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!sessionColumns.some(item => item.name === 'agent_mode')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'normal'");
    }
    if (!sessionColumns.some(item => item.name === 'role_preset')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN role_preset TEXT NOT NULL DEFAULT 'default'");
    }
    const hostColumns = this.all<{ name: string }>('PRAGMA table_info(dev_hosts)');
    if (!hostColumns.some(item => item.name === 'kind')) {
      this.db.exec("ALTER TABLE dev_hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'ssh' CHECK(kind IN ('ssh','local'))");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS local_host_user ON dev_hosts(user_id) WHERE kind='local'");
    for (const [column, type] of [['jump_host', 'TEXT'], ['jump_port', 'INTEGER'], ['jump_username', 'TEXT']]) {
      if (!hostColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE dev_hosts ADD COLUMN ${column} ${type}`);
    }
    const projectColumns = this.all<{ name: string }>('PRAGMA table_info(projects)');
    if (!projectColumns.some(item => item.name === 'path_mode')) {
      this.db.exec("ALTER TABLE projects ADD COLUMN path_mode TEXT NOT NULL DEFAULT 'auto'");
    }
    if (!projectColumns.some(item => item.name === 'execution_mode')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN execution_mode TEXT');
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
