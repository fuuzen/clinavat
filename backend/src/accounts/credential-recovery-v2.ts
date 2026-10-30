import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Store } from '../database.js';
import { HttpError } from '../models.js';
import { clearRuntimeCredential, credentialHash, privateDirectory, readAccountCredential,
  readPrivateJson, writeAccountCredential, writePrivateJson } from './credential-files.js';
import { accountIdentifier, type AccountEngine } from './paths.js';

interface ConversationJournal {
  version: 2; userId: string; slotId: string; engine: AccountEngine; revision: number;
  runtimeHome: string; baseHash: string | null; phase: 'prepared' | 'active' | 'saved' | 'conflict';
}

// Settle old OAuth copies before importing sessions into the fixed-slot layout.
export async function recoverConversationCredentials(dataDir: string, store: Store): Promise<void> {
  const directory = join(dataDir, 'accounts', 'leases-v2');
  await privateDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('凭据恢复日志名称或类型无效');
    const file = join(directory, entry.name);
    const content = await readPrivateJson(file);
    if (!content) continue;
    const journal = JSON.parse(content) as ConversationJournal;
    if (journal.version !== 2 || !['claude', 'codex'].includes(journal.engine)
      || !Number.isSafeInteger(journal.revision) || journal.revision < 0
      || !['prepared', 'active', 'saved', 'conflict'].includes(journal.phase)
      || !(journal.baseHash === null || /^[a-f0-9]{64}$/.test(journal.baseHash))) throw new Error('凭据恢复日志格式无效');
    accountIdentifier(journal.slotId);
    const parts = relative(resolve(dataDir, 'users', accountIdentifier(journal.userId)), resolve(journal.runtimeHome)).split(sep);
    if (parts.length !== 3 || !['sessions', 'model-probes'].includes(parts[0]) || parts[2] !== 'runtime'
      || journal.runtimeHome !== resolve(journal.runtimeHome)) throw new Error('对话凭据运行目录无效');
    accountIdentifier(parts[1]);
    if (entry.name !== `${journal.slotId}.${createHash('sha256').update(journal.runtimeHome).digest('hex')}.json`) throw new Error('凭据恢复日志与运行目录不一致');
    const slot = store.get<{ home_dir: string; engine: string; credential_revision: number }>(
      'SELECT home_dir,engine,credential_revision FROM account_slots WHERE id=?', journal.slotId);
    const access = store.get('SELECT 1 FROM slot_user_access WHERE slot_id=? AND user_id=?', journal.slotId, journal.userId);
    if (!slot || !access || slot.engine !== journal.engine || slot.credential_revision !== journal.revision) throw new Error('授权槽位或访问权限已变化，已保留旧版凭据恢复日志');
    if (journal.phase === 'conflict') throw new HttpError(409, '旧版授权存在并发刷新冲突，请管理员处理 leases-v2 恢复日志后重启');
    if (journal.phase === 'active') {
      const refreshed = await readAccountCredential(journal.runtimeHome, journal.engine);
      const stored = await readAccountCredential(slot.home_dir, journal.engine);
      const refreshedHash = credentialHash(refreshed);
      const storedHash = credentialHash(stored);
      if (refreshedHash !== journal.baseHash && refreshedHash !== storedHash) {
        if (storedHash !== journal.baseHash) {
          journal.phase = 'conflict';
          await writePrivateJson(file, JSON.stringify(journal));
          throw new HttpError(409, '旧版授权凭据被并发修改，已保留两份凭据并停止迁移');
        }
        await writeAccountCredential(slot.home_dir, journal.engine, refreshed);
      }
      journal.phase = 'saved';
      await writePrivateJson(file, JSON.stringify(journal));
    }
    await clearRuntimeCredential(journal.runtimeHome, journal.engine);
    await rm(file, { force: true });
  }
}
