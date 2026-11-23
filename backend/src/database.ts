import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HttpError, type User } from './models.js';
import { ensureLocalHost } from './local-host.js';
import { agentEngines, engineCheck } from './agent/engines.js';

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
        user_id TEXT NOT NULL REFERENCES users(id), engine TEXT NOT NULL ${engineCheck},
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
        report TEXT, notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_tasks_master ON agent_tasks(master_session_id,status);
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, acceptance TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','verifying','blocked','completed','cancelled')),
        assigned_agent TEXT, depends_on TEXT, summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(master_session_id,seq)
      );
      CREATE INDEX IF NOT EXISTS work_items_master ON work_items(master_session_id,seq);
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
      CREATE INDEX IF NOT EXISTS deferred_questions_session ON deferred_questions(session_id,deferred_at);
    `);
    this.addColumn('execution_machines', 'timezone', 'TEXT');
    this.addColumn('sessions', 'slot_mode', "TEXT NOT NULL DEFAULT 'manual' CHECK(slot_mode IN ('manual','auto'))");
    // The Codex thread total a conversation last counted, so repeated totals are not counted twice.
    this.addColumn('sessions', 'token_usage_cursor', 'TEXT');
    this.addColumn('sessions', 'archived_at', 'TEXT');
    // A suspended user keeps every record but can neither sign in nor hold slots, sync or machines.
    this.addColumn('users', 'suspended_at', 'TEXT');
    // Sync ignore rules the user maintains through Clinavat. NULL marks a project from before they moved here,
    // which imports its remote .clinavatignore once before it next syncs.
    this.addColumn('projects', 'sync_rules', 'TEXT');
    // Symbolic links the sync last reported as skipped, as JSON; NULL when there are none.
    this.addColumn('projects', 'sync_skipped_links', 'TEXT');
    // Where a turn ends in the CLI's own history: Claude's last assistant message, Codex's last native turn.
    // Copied turns of a branch keep their source's native session, whose history up to them is the same.
    this.addColumn('session_turns', 'native_ref', 'TEXT');
    this.addColumn('session_turns', 'native_session_id', 'TEXT');
    // A branch starts from its source's native history; fork_native_* apply only until it has its own.
    for (const column of ['forked_from_session_id', 'forked_from_turn_id', 'fork_native_id', 'fork_native_anchor']) {
      this.addColumn('sessions', column, 'TEXT');
    }
    // `claude setup-token` does not record its validity anywhere; the administrator states it with the token.
    this.addColumn('account_slots', 'token_expires_at', 'TEXT');
    // The catalog last read from the slot's CLI; read again only when someone asks to refresh it.
    this.addColumn('account_slots', 'model_catalog', 'TEXT');
    this.addColumn('account_slots', 'model_catalog_at', 'TEXT');
    this.addColumn('account_slots', 'auth_method', "TEXT NOT NULL DEFAULT 'oauth' CHECK(auth_method IN ('oauth','token'))");
    // Whether the slot's assigned members may spend its rate-limit resets; administrators always may.
    this.addColumn('account_slots', 'members_can_reset', 'INTEGER NOT NULL DEFAULT 0 CHECK(members_can_reset IN (0,1))');
    this.addColumn('user_agent_defaults', 'permission_mode',
      "TEXT CHECK(permission_mode IN ('manual','accept-edits','auto','full-access','yolo'))");
    // IDs of the images attached to a user message, as JSON; NULL when there are none.
    this.addColumn('messages', 'images', 'TEXT');
    // Who wrote a user-role message other than the user: a master agent's task, or its children's reports.
    this.addColumn('messages', 'source', "TEXT CHECK(source IN ('delegation','report'))");
    // A child conversation a master agent started; it outlives its master as an ordinary conversation.
    this.addColumn('sessions', 'parent_session_id', 'TEXT REFERENCES sessions(id) ON DELETE SET NULL');
    this.addColumn('sessions', 'agent_name', 'TEXT');
    this.addColumn('sessions', 'agent_access', "TEXT CHECK(agent_access IN ('read','write'))");
    this.addColumn('sessions', 'orchestration', 'INTEGER NOT NULL DEFAULT 0 CHECK(orchestration IN (0,1))');
    this.addColumn('sessions', 'orchestration_mode', "TEXT CHECK(orchestration_mode IN ('off','hybrid','super'))");
    // Where a child agent works, relative to its project's root, and whether that project is a Git worktree of its master's.
    this.addColumn('sessions', 'agent_directory', 'TEXT');
    this.addColumn('sessions', 'agent_isolation', "TEXT CHECK(agent_isolation IN ('shared','worktree'))");
    this.addColumn('sessions', 'agent_ephemeral', 'INTEGER NOT NULL DEFAULT 0 CHECK(agent_ephemeral IN (0,1))');
    // A participant of a discussion, with the position or perspective it argues from in a debate.
    this.addColumn('sessions', 'discussion_id', 'TEXT REFERENCES discussions(id) ON DELETE SET NULL');
    this.addColumn('sessions', 'discussion_stance', 'TEXT');
    // A master's roster as JSON profile IDs, NULL for the whole roster; and the role a child took from its profile.
    this.addColumn('sessions', 'agent_profiles', 'TEXT');
    this.addColumn('sessions', 'agent_instructions', 'TEXT');
    // A worktree project: a child agent's own checkout of its master project's repository, on a branch of its own.
    this.addColumn('projects', 'parent_project_id', 'TEXT REFERENCES projects(id) ON DELETE CASCADE');
    // worktree_conflicts lists, as JSON, the files of the last merge that stopped on conflicts.
    for (const column of ['worktree_repo', 'worktree_path', 'worktree_branch', 'worktree_base', 'worktree_state', 'worktree_conflicts']) {
      this.addColumn('projects', column, 'TEXT');
    }
    // Run once in each new worktree of the project, such as installing dependencies; set by the user, never read from the repository.
    this.addColumn('projects', 'worktree_setup', 'TEXT');
    // Images of a send that failed or of a discarded queued message. The day of grace keeps those of a send
    // retried across a restart.
    this.run(`DELETE FROM message_images WHERE created_at < datetime('now','-1 day')
      AND id NOT IN (SELECT image.value FROM messages, json_each(messages.images) AS image WHERE messages.images IS NOT NULL)
      AND id NOT IN (SELECT image.value FROM session_input_queue, json_tree(session_input_queue.inputs) AS image
        WHERE image.path LIKE '$[%].images')`);
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
    this.widenEngineChecks();
    const interruptedAt = new Date().toISOString();
    this.run(`UPDATE session_turns SET status='interrupted',completed_at=?,paused_at=NULL,
      duration_ms=CASE WHEN status='paused' AND duration_ms IS NOT NULL THEN duration_ms
        ELSE MAX(0,CAST((julianday(?)-julianday(started_at))*86400000 AS INTEGER)-paused_ms) END
      WHERE status IN ('running','pausing','paused')`, interruptedAt, interruptedAt);
    this.run("UPDATE sessions SET status='interrupted' WHERE status IN ('running','waiting','pausing','paused')");
    // Their reports wait for the user in the master's agent panel; a restart never replays them by itself.
    this.run(`UPDATE agent_tasks SET status='interrupted',finished_at=?,report=COALESCE(report,'服务重新启动，子智能体的执行被中断')
      WHERE status='running'`, interruptedAt);
    this.run(`UPDATE discussions SET status='stopped',finished_at=?,detail='服务重新启动，讨论被中断' WHERE status='running'`, interruptedAt);
    this.run("UPDATE dev_hosts SET status='DISCONNECTED' WHERE status='CONNECTED' AND kind='ssh'");
    for (const user of this.all<User>("SELECT * FROM users WHERE role='admin'")) ensureLocalHost(this, user.id);
    this.run("UPDATE approvals SET status='expired', reason='服务重新启动' WHERE status='pending'");
    this.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now());
  }
  private addColumn(table: string, column: string, definition: string) {
    if (this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(item => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  /**
   * Lets the tables created before an engine existed record it. A wider CHECK keeps every stored row valid, so the
   * schema text changes in place: rebuilding tables that others reference with ON DELETE CASCADE could lose rows.
   */
  private widenEngineChecks() {
    const stale = this.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_schema WHERE type='table'").flatMap(table => {
      const check = /CHECK\(engine IN \(([^)]*)\)\)/.exec(table.sql);
      if (!check) return [];
      const known = check[1].split(',').map(value => value.trim().replace(/^'(.*)'$/, '$1'));
      const missing = agentEngines.filter(engine => !known.includes(engine));
      const engines = [...known, ...missing].map(engine => `'${engine}'`).join(',');
      return missing.length ? [{ name: table.name, sql: table.sql.replace(check[0], `CHECK(engine IN (${engines}))`) }] : [];
    });
    if (!stale.length) return;
    this.transaction(() => {
      const { schema_version: version } = this.get<{ schema_version: number }>('PRAGMA schema_version')!;
      this.db.exec('PRAGMA writable_schema=ON');
      try {
        for (const table of stale) this.run("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name=?", table.sql, table.name);
        this.db.exec(`PRAGMA schema_version=${version + 1}`);
      } finally { this.db.exec('PRAGMA writable_schema=OFF'); }
    });
    const { integrity_check: result } = this.get<{ integrity_check: string }>('PRAGMA integrity_check')!;
    if (result !== 'ok') throw new Error(`数据库结构更新后完整性检查失败：${result}`);
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
