import { randomUUID } from 'node:crypto';
import { readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory, writePrivateJson } from '../credential-files.js';
import type { AccountEngine } from '../paths.js';
import { metadata } from './files.js';
import { sessionStateFiles } from './layout.js';

function assertEmpty(database: DatabaseSync): void {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_goals'").get();
  if (!table || database.prepare('SELECT 1 FROM thread_goals LIMIT 1').get()) {
    throw new Error('旧原生目标数据库含目标或格式无法识别，已保留原文件，请先迁移目标状态');
  }
}

export async function assertEmptyLegacyGoalDatabase(file: string): Promise<void> {
  const entry = await metadata(file);
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('旧原生目标数据库必须是实际文件');
  if (!entry.size) return;
  const database = new DatabaseSync(file, { readOnly: true });
  try { assertEmpty(database); }
  finally { database.close(); }
}

async function archiveEmptyDatabase(file: string, root: string): Promise<void> {
  await assertEmptyLegacyGoalDatabase(file);
  const entry = await metadata(file);
  if (!entry) return;
  if (entry.size) {
    const database = new DatabaseSync(file);
    try {
      database.exec('PRAGMA busy_timeout=5000');
      assertEmpty(database);
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      if (checkpoint.busy) throw new Error('旧原生目标数据库仍在使用，已停止绑定');
    } finally { database.close(); }
  }
  for (const suffix of ['-wal', '-shm']) {
    if (await metadata(file + suffix)) throw new Error('旧原生目标数据库仍有写入日志，已保留原文件并停止绑定');
  }
  const archive = join(root, 'legacy-empty-goals', randomUUID());
  await privateDirectory(archive);
  await writePrivateJson(join(archive, 'source.json'), JSON.stringify({ version: 1, file, empty: true }));
  await rename(file, join(archive, 'goals_1.sqlite'));
}

async function assertTarget(root: string, name: string): Promise<void> {
  const target = await metadata(join(root, name));
  if (target && (!target.isFile() || target.isSymbolicLink())) throw new Error('用户原生目标数据库必须是实际文件');
}

export async function bindSessionStateFiles(directory: string, root: string, engine: AccountEngine): Promise<void> {
  for (const name of sessionStateFiles(engine)) {
    await assertTarget(root, name);
    const file = join(directory, name);
    const existing = await metadata(file);
    if (existing?.isSymbolicLink()) {
      if (resolve(directory, await readlink(file)) !== join(root, name)) throw new Error('槽位原生目标数据库指向意外位置');
      continue;
    }
    if (existing) await archiveEmptyDatabase(file, root);
    for (const suffix of ['-wal', '-shm']) {
      if (await metadata(file + suffix)) throw new Error('槽位原生目标数据库残留未归档日志，已停止绑定');
    }
    // SQLite resolves this link before opening WAL/SHM, so those files share the target directory.
    await symlink(join(root, name), file, 'file');
  }
}

export async function detachSessionStateFiles(directory: string, root: string, engine: AccountEngine): Promise<void> {
  for (const name of sessionStateFiles(engine)) {
    const file = join(directory, name);
    const entry = await metadata(file);
    if (!entry) continue;
    if (!entry.isSymbolicLink() || resolve(directory, await readlink(file)) !== join(root, name)) {
      throw new Error('槽位原生目标数据库映射已被替换，已保留现场并停止释放');
    }
    await rm(file);
  }
}

export async function assertSessionStateFiles(directory: string, root: string, engine: AccountEngine): Promise<void> {
  for (const name of sessionStateFiles(engine)) {
    const file = join(directory, name);
    if (!(await metadata(file))?.isSymbolicLink() || resolve(dirname(file), await readlink(file)) !== join(root, name)) {
      throw new Error('槽位原生目标数据库映射失效');
    }
    await assertTarget(root, name);
  }
}
