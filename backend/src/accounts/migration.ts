import { chmod, lstat, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Store } from '../database.js';
import {
  copyClaudeAccount, credentialHash, privateDirectory, readAccountCredential, readPrivateJson,
  writeAccountCredential, writePrivateJson,
} from './credential-files.js';
import { accountIdentifier, userRuntimeHome } from './paths.js';
import { assertAccountProcessesStopped, migrateSessionPaths, migrateUserState, pathExists } from './migration-state.js';

interface MigrationSlot {
  id: string;
  home_dir: string;
  assigned_user_id?: string | null;
}

interface HomeMigration {
  version: 1;
  slotId: string;
  userId: string | null;
  phase: 'prepared' | 'archived' | 'complete';
}

const journalPath = (dataDir: string, slotId: string) => join(dataDir, 'accounts', 'layout', `${accountIdentifier(slotId)}.json`);

export async function initializeSlotLayout(dataDir: string, slot: MigrationSlot): Promise<void> {
  const journal: HomeMigration = { version: 1, slotId: slot.id, userId: slot.assigned_user_id ?? null, phase: 'complete' };
  await writePrivateJson(journalPath(dataDir, slot.id), JSON.stringify(journal));
}

async function restoreSlotCredentials(archive: string, home: string): Promise<void> {
  await privateDirectory(home);
  for (const engine of ['claude', 'codex'] as const) {
    const source = await readAccountCredential(archive, engine);
    if (source === undefined) continue;
    const existing = await readAccountCredential(home, engine);
    if (existing !== undefined && credentialHash(existing) !== credentialHash(source)) {
      throw new Error('迁移期间槽位凭据已被重新登录修改，已保留两份认证数据');
    }
    if (existing === undefined) await writeAccountCredential(home, engine, source);
  }
  await copyClaudeAccount(archive, home);
}

export async function migrateAccountHomes(dataDir: string, store: Store): Promise<void> {
  const columns = store.all<{ name: string }>('PRAGMA table_info(account_slots)');
  if (columns.some(column => column.name === 'engine')) {
    const slots = store.all<{ home_dir: string }>('SELECT home_dir FROM account_slots');
    await assertAccountProcessesStopped(dataDir, slots.map(slot => slot.home_dir));
    return;
  }
  const slots = store.all<MigrationSlot>('SELECT id,home_dir,assigned_user_id FROM account_slots ORDER BY id');
  await assertAccountProcessesStopped(dataDir, slots.map(slot => slot.home_dir));
  let backedUp = false;
  for (const slot of slots) {
    accountIdentifier(slot.id);
    const file = journalPath(dataDir, slot.id);
    const saved = await readPrivateJson(file);
    const journal = saved ? JSON.parse(saved) as HomeMigration : {
      version: 1 as const, slotId: slot.id, userId: slot.assigned_user_id ?? null, phase: 'prepared' as const,
    };
    if (journal.version !== 1 || journal.slotId !== slot.id || !['prepared', 'archived', 'complete'].includes(journal.phase)) {
      throw new Error('槽位目录迁移日志无效');
    }
    if (journal.phase === 'complete') continue;
    if (journal.userId !== (slot.assigned_user_id ?? null)) throw new Error('迁移尚未完成时槽位归属发生变化，已停止迁移');
    if (resolve(slot.home_dir) !== resolve(dataDir, 'slots', slot.id)) {
      throw new Error('槽位目录不在预期的数据根目录下，请先恢复原数据根配置');
    }
    if (!backedUp) {
      const directory = join(dataDir, 'backups', 'account-homes-v1');
      await privateDirectory(directory);
      const backup = join(directory, 'before-migration.sqlite');
      if (!await pathExists(backup)) store.run('VACUUM INTO ?', backup);
      await chmod(backup, 0o600);
      backedUp = true;
    }
    const archive = join(dataDir, 'backups', 'account-homes-v1', slot.id);
    if (!saved && await pathExists(archive)) throw new Error('旧槽位归档已存在但缺少迁移日志，拒绝覆盖或推断数据归属');
    await writePrivateJson(file, JSON.stringify(journal));
    if (journal.phase === 'prepared') {
      if (!await pathExists(archive)) {
        await privateDirectory(slot.home_dir);
        await readAccountCredential(slot.home_dir, 'claude');
        await readAccountCredential(slot.home_dir, 'codex');
        await rename(slot.home_dir, archive);
      } else {
        const metadata = await lstat(archive);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('旧槽位归档必须是实际目录');
      }
      journal.phase = 'archived';
      await writePrivateJson(file, JSON.stringify(journal));
    }
    if (journal.userId) await migrateUserState(dataDir, journal.userId, slot.id, archive, slot.home_dir);
    await restoreSlotCredentials(archive, slot.home_dir);
    if (journal.userId) {
      store.transaction(() => migrateSessionPaths(store, journal.userId!, slot.home_dir, userRuntimeHome(dataDir, journal.userId!)));
    }
    journal.phase = 'complete';
    await writePrivateJson(file, JSON.stringify(journal));
  }
}
