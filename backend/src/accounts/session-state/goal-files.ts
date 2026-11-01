import { randomUUID } from 'node:crypto';
import { readlink, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { privateDirectory, writePrivateJson } from '../credential-files.js';
import type { AccountEngine } from '../paths.js';
import { metadata } from './files.js';
import { sessionStateFiles } from './layout.js';

// Only a CLI started outside a lease can leave a real database here. It is never opened: the slot is writable from
// execution environments, and the Hub must not parse files from there as SQLite.
async function archiveUnboundDatabase(file: string, root: string): Promise<void> {
  const entry = await metadata(file);
  if (!entry) return;
  if (!entry.isFile()) throw new Error('槽位内的原生目标数据库必须是实际文件');
  const archive = join(root, 'unbound-goals', randomUUID());
  await privateDirectory(archive);
  await writePrivateJson(join(archive, 'source.json'), JSON.stringify({ version: 1, file }));
  for (const suffix of ['', '-wal', '-shm']) {
    if (await metadata(file + suffix)) await rename(file + suffix, join(archive, basename(file) + suffix));
  }
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
    if (existing) await archiveUnboundDatabase(file, root);
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
