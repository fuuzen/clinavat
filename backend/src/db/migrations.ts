import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { agentEngines, engineCheck } from '../agent/engines.js';
import { superReadModeColumn } from './schema.js';

export interface MigrationStore {
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  run(sql: string, ...params: SQLInputValue[]): unknown;
  transaction<T>(operation: () => T): T;
}

function addColumn(db: DatabaseSync, store: MigrationStore, table: string, column: string, definition: string): void {
  if (store.all<{ name: string }>(`PRAGMA table_info(${table})`).some(item => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Rebuilds legacy work_items tables to add stage + archived_at and widen UNIQUE(master_session_id,stage,seq).
 * Foreign keys must be disabled outside the transaction so dropping the old table does not null agent_tasks.work_item_id.
 */
function migrateWorkItems(db: DatabaseSync, store: MigrationStore): void {
  const columns = store.all<{ name: string }>('PRAGMA table_info(work_items)').map(item => item.name);
  const hasStage = columns.includes('stage');
  const hasArchivedAt = columns.includes('archived_at');
  if (!hasStage || !hasArchivedAt) {
    const unexpectedObjects = store.all<{ type: string; name: string }>(
      "SELECT type,name FROM sqlite_schema WHERE type IN ('trigger','view') AND sql LIKE '%work_items%'");
    if (unexpectedObjects.length) {
      throw new Error(`work_items 存在未预期的触发器或视图，已中止迁移：${unexpectedObjects.map(o => `${o.type}:${o.name}`).join(', ')}`);
    }
    const unexpectedRefs = store.all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('work_items','agent_tasks') AND sql LIKE '%work_items%'");
    if (unexpectedRefs.length) {
      throw new Error(`存在除 agent_tasks 外引用 work_items 的表，已中止迁移：${unexpectedRefs.map(t => t.name).join(', ')}`);
    }
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      store.transaction(() => db.exec(`
        DROP TABLE IF EXISTS work_items_staged;
        CREATE TABLE work_items_staged (
          id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          stage INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, acceptance TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','verifying','blocked','completed','cancelled')),
          assigned_agent TEXT, depends_on TEXT, summary TEXT, review_rounds INTEGER NOT NULL DEFAULT 0,
          archived_at TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(master_session_id,stage,seq)
        );
        INSERT INTO work_items_staged(id,master_session_id,stage,seq,title,description,acceptance,status,assigned_agent,depends_on,summary,review_rounds,archived_at,created_at,updated_at)
          SELECT id,master_session_id,${hasStage ? 'COALESCE(stage,1)' : '1'},seq,title,description,acceptance,status,assigned_agent,depends_on,summary,COALESCE(review_rounds,0),${hasArchivedAt ? 'archived_at' : 'NULL'},created_at,updated_at
          FROM work_items;
        DROP TABLE work_items;
        ALTER TABLE work_items_staged RENAME TO work_items;
      `));
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS work_items_master ON work_items(master_session_id,stage,seq);
    CREATE INDEX IF NOT EXISTS idx_work_items_master_active ON work_items(master_session_id,archived_at,stage,seq);
  `);
}

function migrateSlotQuotaLimits(db: DatabaseSync, store: MigrationStore): void {
  if (!store.all<{ name: string }>('PRAGMA table_info(slot_quota_limits)').some(column => column.name === 'account_key')) {
    db.exec('ALTER TABLE slot_quota_limits ADD COLUMN account_key TEXT');
  }
  if (!store.all<{ name: string; pk: number }>('PRAGMA table_info(slot_quota_limits)').some(column => column.name === 'account_key' && column.pk)) {
    store.transaction(() => db.exec(`
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
}

/**
 * Updates table DDL in place when widening a CHECK constraint. Every stored row remains valid, and rebuilding
 * tables referenced with ON DELETE CASCADE could otherwise lose dependent rows.
 */
function rewriteTableSchemas(db: DatabaseSync, store: MigrationStore, updates: { name: string; sql: string }[]): void {
  if (!updates.length) return;
  store.transaction(() => {
    const { schema_version: version } = store.get<{ schema_version: number }>('PRAGMA schema_version')!;
    db.exec('PRAGMA writable_schema=ON');
    try {
      for (const table of updates) {
        store.run("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name=?", table.sql, table.name);
      }
      db.exec(`PRAGMA schema_version=${version + 1}`);
    } finally {
      db.exec('PRAGMA writable_schema=OFF');
    }
  });
  const { integrity_check: result } = store.get<{ integrity_check: string }>('PRAGMA integrity_check')!;
  if (result !== 'ok') throw new Error(`数据库结构更新后完整性检查失败：${result}`);
}

/** Lets tables created before an engine existed record it by widening CHECK(engine IN (...)) in place. */
function widenEngineChecks(db: DatabaseSync, store: MigrationStore): void {
  const stale = store.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_schema WHERE type='table'").flatMap(table => {
    const check = /CHECK\(engine IN \(([^)]*)\)\)/.exec(table.sql);
    if (!check) return [];
    const known = check[1].split(',').map(value => value.trim().replace(/^'(.*)'$/, '$1'));
    const missing = agentEngines.filter(engine => !known.includes(engine));
    const engines = [...known, ...missing].map(engine => `'${engine}'`).join(',');
    return missing.length ? [{ name: table.name, sql: table.sql.replace(check[0], `CHECK(engine IN (${engines}))`) }] : [];
  });
  rewriteTableSchemas(db, store, stale);
}

/** Widens dev_hosts.kind CHECK constraint in place to include 'client' on pre-existing databases. */
function widenDevHostKindCheck(db: DatabaseSync, store: MigrationStore): void {
  const table = store.get<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name='dev_hosts'");
  if (!table?.sql) return;
  const check = /CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i.exec(table.sql);
  if (!check) return;
  const known = check[1].split(',').map(value => value.trim().replace(/^'(.*)'$/, '$1'));
  if (known.includes('client')) return;
  const kinds = [...known, 'client'].map(kind => `'${kind}'`).join(',');
  rewriteTableSchemas(db, store, [{ name: table.name, sql: table.sql.replace(check[0], `CHECK(kind IN (${kinds}))`) }]);
}

/** Widens native_inspect_tools CHECK constraint from IN (0,1) to >= 0 for Codex dynamic toolset bitmask encoding. */
function widenNativeInspectToolsCheck(db: DatabaseSync, store: MigrationStore): void {
  const updates: { name: string; sql: string }[] = [];
  for (const name of ['sessions', 'session_turns']) {
    const table = store.get<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name=?", name);
    if (!table?.sql) continue;
    const check = /CHECK\s*\(\s*native_inspect_tools\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.exec(table.sql);
    if (!check) continue;
    updates.push({ name: table.name, sql: table.sql.replace(check[0], 'CHECK(native_inspect_tools >= 0)') });
  }
  rewriteTableSchemas(db, store, updates);
}

export function runMigrations(db: DatabaseSync, store: MigrationStore): void {
  addColumn(db, store, 'execution_machines', 'timezone', 'TEXT');
  addColumn(db, store, 'sessions', 'slot_mode', "TEXT NOT NULL DEFAULT 'manual' CHECK(slot_mode IN ('manual','auto'))");
  // The Codex thread total a conversation last counted, so repeated totals are not counted twice.
  addColumn(db, store, 'sessions', 'token_usage_cursor', 'TEXT');
  addColumn(db, store, 'sessions', 'last_context_tokens', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, store, 'sessions', 'last_context_window', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, store, 'sessions', 'archived_at', 'TEXT');
  // A suspended user keeps every record but can neither sign in nor hold slots, sync or machines.
  addColumn(db, store, 'users', 'suspended_at', 'TEXT');
  // Sync ignore rules the user maintains through Clinavat. NULL marks a project from before they moved here,
  // which imports its remote .clinavatignore once before it next syncs.
  addColumn(db, store, 'projects', 'sync_rules', 'TEXT');
  // Symbolic links the sync last reported as skipped, as JSON; NULL when there are none.
  addColumn(db, store, 'projects', 'sync_skipped_links', 'TEXT');
  addColumn(db, store, 'projects', 'client_mode', "TEXT NOT NULL DEFAULT 'direct'");
  addColumn(db, store, 'projects', 'vm_path', 'TEXT');
  // Where a turn ends in the CLI's own history: Claude's last assistant message, Codex's last native turn.
  // Copied turns of a branch keep their source's native session, whose history up to them is the same.
  addColumn(db, store, 'session_turns', 'native_ref', 'TEXT');
  addColumn(db, store, 'session_turns', 'native_session_id', 'TEXT');
  addColumn(db, store, 'session_turns', 'native_inspect_tools', 'INTEGER NOT NULL DEFAULT 0 CHECK(native_inspect_tools >= 0)');
  // A branch starts from its source's native history; fork_native_* apply only until it has its own.
  for (const column of ['forked_from_session_id', 'forked_from_turn_id', 'fork_native_id', 'fork_native_anchor']) {
    addColumn(db, store, 'sessions', column, 'TEXT');
  }
  // `claude setup-token` does not record its validity anywhere; the administrator states it with the token.
  addColumn(db, store, 'account_slots', 'token_expires_at', 'TEXT');
  // The catalog last read from the slot's CLI; read again only when someone asks to refresh it.
  addColumn(db, store, 'account_slots', 'model_catalog', 'TEXT');
  addColumn(db, store, 'account_slots', 'model_catalog_at', 'TEXT');
  addColumn(db, store, 'account_slots', 'auth_method', "TEXT NOT NULL DEFAULT 'oauth' CHECK(auth_method IN ('oauth','token'))");
  // Whether the slot's assigned members may spend its rate-limit resets; administrators always may.
  addColumn(db, store, 'account_slots', 'members_can_reset', 'INTEGER NOT NULL DEFAULT 0 CHECK(members_can_reset IN (0,1))');
  addColumn(db, store, 'user_agent_defaults', 'permission_mode',
    "TEXT CHECK(permission_mode IN ('manual','accept-edits','auto','full-access','yolo'))");
  // IDs of the images attached to a user message, as JSON; NULL when there are none.
  addColumn(db, store, 'messages', 'images', 'TEXT');
  // Who wrote a user-role message other than the user: a master agent's task, or its children's reports.
  addColumn(db, store, 'messages', 'source', "TEXT CHECK(source IN ('delegation','report'))");
  // A child conversation a master agent started; it outlives its master as an ordinary conversation.
  addColumn(db, store, 'sessions', 'parent_session_id', 'TEXT REFERENCES sessions(id) ON DELETE SET NULL');
  addColumn(db, store, 'sessions', 'agent_name', 'TEXT');
  addColumn(db, store, 'sessions', 'agent_access', "TEXT CHECK(agent_access IN ('read','write'))");
  addColumn(db, store, 'sessions', 'orchestration', 'INTEGER NOT NULL DEFAULT 0 CHECK(orchestration IN (0,1))');
  addColumn(db, store, 'sessions', 'orchestration_mode', "TEXT CHECK(orchestration_mode IN ('off','hybrid','super'))");
  addColumn(db, store, 'sessions', 'super_read_mode', superReadModeColumn);
  // Codex stores the tool list with its native thread. Bitmask tracks inspect and client-direct toolsets.
  addColumn(db, store, 'sessions', 'native_inspect_tools', 'INTEGER NOT NULL DEFAULT 0 CHECK(native_inspect_tools >= 0)');
  addColumn(db, store, 'sessions', 'agent_profile', 'TEXT');
  addColumn(db, store, 'work_items', 'review_rounds', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, store, 'agent_tasks', 'work_item_id', 'TEXT REFERENCES work_items(id) ON DELETE SET NULL');
  migrateWorkItems(db, store);
  addColumn(db, store, 'agent_tasks', 'wave', 'TEXT');
  // Where a child agent works, relative to its project's root, and whether that project is a Git worktree of its master's.
  addColumn(db, store, 'sessions', 'agent_directory', 'TEXT');
  addColumn(db, store, 'sessions', 'agent_isolation', "TEXT CHECK(agent_isolation IN ('shared','worktree'))");
  addColumn(db, store, 'sessions', 'agent_ephemeral', 'INTEGER NOT NULL DEFAULT 0 CHECK(agent_ephemeral IN (0,1))');
  // A participant of a discussion, with the position or perspective it argues from in a debate.
  addColumn(db, store, 'sessions', 'discussion_id', 'TEXT REFERENCES discussions(id) ON DELETE SET NULL');
  addColumn(db, store, 'sessions', 'discussion_stance', 'TEXT');
  // A master's roster as JSON profile IDs, NULL for the whole roster; and the role a child took from its profile.
  addColumn(db, store, 'sessions', 'agent_profiles', 'TEXT');
  addColumn(db, store, 'sessions', 'agent_instructions', 'TEXT');
  // A worktree project: a child agent's own checkout of its master project's repository, on a branch of its own.
  addColumn(db, store, 'projects', 'parent_project_id', 'TEXT REFERENCES projects(id) ON DELETE CASCADE');
  // worktree_conflicts lists, as JSON, the files of the last merge that stopped on conflicts.
  for (const column of ['worktree_repo', 'worktree_path', 'worktree_branch', 'worktree_base', 'worktree_state', 'worktree_conflicts']) {
    addColumn(db, store, 'projects', column, 'TEXT');
  }
  // Run once in each new worktree of the project, such as installing dependencies; set by the user, never read from the repository.
  addColumn(db, store, 'projects', 'worktree_setup', 'TEXT');
  // Question settings left NULL follow the next level: conversation, then its user, then the site.
  for (const table of ['users', 'sessions']) {
    addColumn(db, store, table, 'question_mode', "TEXT CHECK(question_mode IN ('skip','defer'))");
    addColumn(db, store, table, 'question_timeout_ms', 'INTEGER');
  }
  db.exec(`
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
  migrateSlotQuotaLimits(db, store);
  widenEngineChecks(db, store);
  widenDevHostKindCheck(db, store);
  widenNativeInspectToolsCheck(db, store);
}
