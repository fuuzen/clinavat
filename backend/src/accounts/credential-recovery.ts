import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../database.js';
import {
  clearRuntimeCredential, credentialHash, privateDirectory, readAccountCredential,
  readPrivateJson, writeAccountCredential, writePrivateJson,
} from './credential-files.js';
import { accountIdentifier, credentialJournalPath, userRuntimeHome, type AccountEngine } from './paths.js';

interface LegacyJournal {
  version: 1; userId: string; slotId: string; engine: AccountEngine; revision: number;
  baseHash: string | null; phase: 'prepared' | 'active' | 'saved';
}

export async function recoverLegacyCredentials(dataDir: string, store: Store): Promise<void> {
  const directory = join(dataDir, 'accounts', 'leases');
  await privateDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) throw new Error('凭据恢复日志必须是普通文件');
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.(claude|codex)\.json$/.exec(entry.name);
    if (!match) throw new Error('凭据恢复日志名称无效');
    const file = credentialJournalPath(dataDir, match[1], match[2] as AccountEngine);
    const content = await readPrivateJson(file);
    if (!content) continue;
    const journal = JSON.parse(content) as LegacyJournal;
    if (journal.version !== 1 || journal.userId !== match[1] || journal.engine !== match[2]
      || !Number.isSafeInteger(journal.revision) || journal.revision < 0
      || !['prepared', 'active', 'saved'].includes(journal.phase)
      || !(journal.baseHash === null || /^[a-f0-9]{64}$/.test(journal.baseHash))) {
      throw new Error('旧版凭据恢复日志格式无效');
    }
    accountIdentifier(journal.slotId);
    const legacySchema = store.all<{ name: string }>('PRAGMA table_info(account_slots)').some(column => column.name === 'assigned_user_id');
    if (!legacySchema) throw new Error('发现尚未处理的旧版凭据日志，必须先恢复旧版账号数据再升级');
    const slot = store.get<{ home_dir: string; assigned_user_id: string | null; credential_revision: number }>(
      'SELECT home_dir,assigned_user_id,credential_revision FROM account_slots WHERE id=?', journal.slotId,
    );
    if (!slot || slot.assigned_user_id !== journal.userId || slot.credential_revision !== journal.revision) {
      throw new Error('旧版凭据归属发生变化，已保留恢复日志并阻止覆盖');
    }
    const home = userRuntimeHome(dataDir, journal.userId);
    if (journal.phase === 'active') {
      const refreshed = await readAccountCredential(home, journal.engine);
      const stored = await readAccountCredential(slot.home_dir, journal.engine);
      if (credentialHash(stored) === journal.baseHash && credentialHash(refreshed) !== journal.baseHash) {
        await writeAccountCredential(slot.home_dir, journal.engine, refreshed);
      }
      journal.phase = 'saved';
      await writePrivateJson(file, JSON.stringify(journal));
    }
    await clearRuntimeCredential(home, journal.engine);
    await rm(file, { force: true });
  }
}
