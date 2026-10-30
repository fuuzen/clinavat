import { chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Store } from '../database.js';
import type { AccountEngine } from './paths.js';
import { accountIdentifier } from './paths.js';
import {
  clearRuntimeCredential, copyClaudeAccount, credentialHash, privateDirectory,
  readAccountCredential, readPrivateJson, writeAccountCredential, writePrivateJson,
} from './credential-files.js';
import { pathExists } from './migration-state.js';

interface LegacySlot {
  id: string; label: string; home_dir: string; cli_types: string; assigned_user_id: string | null;
  status: string; credential_revision: number; updated_at: string;
}
interface SlotMigrationEntry {
  source: LegacySlot;
  targets: { id: string; engine: AccountEngine; home: string }[];
}
interface SlotMigrationPlan { version: 1; entries: SlotMigrationEntry[] }

function parseEngines(value: string): AccountEngine[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(engine => !['claude', 'codex'].includes(engine))) {
    throw new Error('旧槽位引擎配置无效，请修复后重试');
  }
  return [...new Set(parsed)] as AccountEngine[];
}

async function createPlan(dataDir: string, store: Store): Promise<SlotMigrationPlan> {
  const sources = store.all<LegacySlot>('SELECT * FROM account_slots ORDER BY id');
  const identifiers = new Set(sources.map(slot => slot.id));
  const entries: SlotMigrationEntry[] = [];
  for (const source of sources) {
    accountIdentifier(source.id);
    if (resolve(source.home_dir) !== resolve(dataDir, 'slots', source.id)) {
      throw new Error('旧槽位目录不在预期的数据根目录中');
    }
    const targets: SlotMigrationEntry['targets'] = [];
    for (const [index, engine] of parseEngines(source.cli_types).entries()) {
      let id = source.id;
      if (index) {
        const prefix = `${source.id.slice(0, 52)}-${engine}`;
        id = prefix;
        let suffix = 2;
        while (identifiers.has(id)) id = `${prefix}-${suffix++}`;
        accountIdentifier(id);
        if (await pathExists(join(dataDir, 'slots', id))) throw new Error('拆分槽位的目标目录已存在，请先检查数据');
        identifiers.add(id);
      }
      targets.push({ id, engine, home: join(dataDir, 'slots', id) });
    }
    entries.push({ source, targets });
  }
  return { version: 1, entries };
}

function validatePlan(plan: SlotMigrationPlan, dataDir: string): void {
  if (plan.version !== 1 || !Array.isArray(plan.entries)) throw new Error('槽位拆分迁移日志无效');
  const identifiers = new Set<string>();
  for (const { source, targets } of plan.entries) {
    accountIdentifier(source.id);
    if (resolve(source.home_dir) !== resolve(dataDir, 'slots', source.id)) throw new Error('迁移源目录无效');
    const engines = parseEngines(source.cli_types);
    if (targets.length !== engines.length) throw new Error('迁移引擎映射无效');
    for (const [index, target] of targets.entries()) {
      accountIdentifier(target.id);
      if (target.engine !== engines[index] || identifiers.has(target.id)
        || resolve(target.home) !== resolve(dataDir, 'slots', target.id)
        || (index === 0 && target.id !== source.id)) throw new Error('迁移槽位映射无效');
      identifiers.add(target.id);
    }
  }
}

async function stageCredentials(plan: SlotMigrationPlan): Promise<void> {
  for (const { source, targets } of plan.entries) {
    for (const target of targets) {
      if (target.id === source.id) continue;
      await privateDirectory(target.home);
      const credential = await readAccountCredential(source.home_dir, target.engine);
      const existing = await readAccountCredential(target.home, target.engine);
      if (existing !== undefined && credentialHash(existing) !== credentialHash(credential)) {
        throw new Error('拆分槽位的目标凭据已变化，已保留原始凭据并停止迁移');
      }
      if (existing === undefined && credential !== undefined) await writeAccountCredential(target.home, target.engine, credential);
      if (target.engine === 'claude') await copyClaudeAccount(source.home_dir, target.home);
    }
  }
}

function applySchema(plan: SlotMigrationPlan, store: Store): void {
  store.transaction(() => {
    store.run(`CREATE TABLE account_slots_v2 (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE,
      engine TEXT NOT NULL CHECK(engine IN ('claude','codex')),
      status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('IDLE','RATE_LIMITED','DISABLED')),
      credential_revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    for (const { source, targets } of plan.entries) {
      for (const target of targets) {
        const status = ['RATE_LIMITED', 'DISABLED'].includes(source.status) ? source.status : 'IDLE';
        const suffix = ` · ${target.engine}`;
        const label = targets.length > 1 ? `${source.label.slice(0, 100 - suffix.length)}${suffix}` : source.label;
        store.run('INSERT INTO account_slots_v2(id,label,home_dir,engine,status,credential_revision,updated_at) VALUES(?,?,?,?,?,?,?)',
          target.id, label, target.home, target.engine, status, source.credential_revision, source.updated_at);
      }
    }
    store.run('DROP TABLE account_slots');
    store.run('ALTER TABLE account_slots_v2 RENAME TO account_slots');
    store.run(`CREATE TABLE slot_user_access (
      slot_id TEXT NOT NULL REFERENCES account_slots(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(slot_id,user_id)
    )`);
    store.run('CREATE INDEX slot_access_user ON slot_user_access(user_id,slot_id)');
    for (const { source, targets } of plan.entries) {
      if (!source.assigned_user_id) continue;
      for (const target of targets) {
        store.run('INSERT INTO slot_user_access(slot_id,user_id) VALUES(?,?)', target.id, source.assigned_user_id);
        store.run('UPDATE sessions SET slot_id=? WHERE user_id=? AND engine=? AND slot_id IS NULL',
          target.id, source.assigned_user_id, target.engine);
      }
    }
  });
}

export async function migrateSlotSchema(dataDir: string, store: Store): Promise<void> {
  const file = join(dataDir, 'accounts', 'single-engine-slots.json');
  const saved = await readPrivateJson(file);
  const columns = store.all<{ name: string }>('PRAGMA table_info(account_slots)');
  const migrated = columns.some(column => column.name === 'engine');
  if (migrated && !saved) return;
  const plan = saved ? JSON.parse(saved) as SlotMigrationPlan : await createPlan(dataDir, store);
  validatePlan(plan, dataDir);
  if (!migrated) {
    const backupDirectory = join(dataDir, 'backups', 'single-engine-slots-v1');
    await privateDirectory(backupDirectory);
    const backup = join(backupDirectory, 'before-migration.sqlite');
    if (!await pathExists(backup)) store.run('VACUUM INTO ?', backup);
    await chmod(backup, 0o600);
    if (!saved) await writePrivateJson(file, JSON.stringify(plan));
    await stageCredentials(plan);
    applySchema(plan, store);
  }
  for (const { source, targets } of plan.entries) {
    if (targets.length > 1) await clearRuntimeCredential(source.home_dir, targets[1].engine);
  }
}
