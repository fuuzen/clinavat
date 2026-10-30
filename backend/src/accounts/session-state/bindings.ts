import { readdir, readlink, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Store } from '../../database.js';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../credential-files.js';
import { accountIdentifier, type AccountEngine } from '../paths.js';
import { metadata } from './files.js';
import { assertSessionStateFiles, bindSessionStateFiles, detachSessionStateFiles } from './goal-files.js';
import { engineDirectory, sessionStateDirectories, sessionStateFiles, userSessionStateRoot } from './layout.js';
import { ensureUserSessionState } from './migration.js';

interface BindingMarker { version: 1; userId: string; engine: AccountEngine; root: string }
const markerName = '.slot-session-state.json';

async function readBinding(home: string): Promise<BindingMarker | undefined> {
  const content = await readPrivateJson(join(home, markerName));
  if (!content) return undefined;
  const marker = JSON.parse(content) as BindingMarker;
  if (marker.version !== 1 || !['claude', 'codex'].includes(marker.engine)
    || typeof marker.root !== 'string' || !marker.root.startsWith('/')) throw new Error('槽位会话目录映射记录无效');
  accountIdentifier(marker.userId);
  return marker;
}

export async function bindSlotSessionState(dataDir: string, store: Store, userId: string, slotHome: string, engine: AccountEngine): Promise<void> {
  const root = resolve(await ensureUserSessionState(dataDir, store, userId, engine));
  const previous = await readBinding(slotHome);
  if (previous && (previous.userId !== userId || previous.engine !== engine || previous.root !== root)) {
    throw new Error('槽位仍连接其他用户的原生会话存储');
  }
  const directory = engineDirectory(slotHome, engine);
  await privateDirectory(directory);
  await writePrivateJson(join(slotHome, markerName), JSON.stringify({ version: 1, userId, engine, root } satisfies BindingMarker));
  for (const name of sessionStateDirectories(engine)) {
    const file = join(directory, name);
    const target = join(root, name);
    await privateDirectory(target);
    const existing = await metadata(file);
    if (existing?.isSymbolicLink()) {
      if (resolve(directory, await readlink(file)) !== target) throw new Error('槽位原生会话目录指向意外位置');
      continue;
    }
    if (existing) {
      if (!existing.isDirectory() || (await readdir(file)).length) throw new Error('槽位原生会话目录含未归档数据，拒绝覆盖');
      await rm(file, { recursive: true });
    }
    await symlink(target, file, 'dir');
  }
  await bindSessionStateFiles(directory, root, engine);
}

export async function detachSlotSessionState(slotHome: string, engine: AccountEngine): Promise<void> {
  const marker = await readBinding(slotHome);
  const directory = engineDirectory(slotHome, engine);
  if (!marker) {
    for (const name of [...sessionStateDirectories(engine), ...sessionStateFiles(engine)]) {
      if ((await metadata(join(directory, name)))?.isSymbolicLink()) throw new Error('槽位会话目录映射缺少归属记录');
    }
    return;
  }
  if (marker.engine !== engine) throw new Error('槽位会话目录映射引擎不匹配');
  await detachSessionStateFiles(directory, marker.root, engine);
  for (const name of sessionStateDirectories(engine)) {
    const file = join(directory, name);
    const existing = await metadata(file);
    if (!existing) continue;
    if (!existing.isSymbolicLink() || resolve(directory, await readlink(file)) !== join(marker.root, name)) {
      throw new Error('槽位会话目录映射已被替换，已保留现场并停止释放');
    }
    // Removing a directory link must never recurse into the user's persistent history.
    await rm(file);
  }
  await rm(join(slotHome, markerName), { force: true });
}

export async function assertSlotSessionState(dataDir: string, userId: string, slotHome: string, engine: AccountEngine): Promise<void> {
  const marker = await readBinding(slotHome);
  const root = resolve(userSessionStateRoot(dataDir, userId, engine));
  if (!marker || marker.userId !== userId || marker.engine !== engine || marker.root !== root) {
    throw new Error('槽位原生会话存储归属不匹配');
  }
  const directory = engineDirectory(slotHome, engine);
  for (const name of sessionStateDirectories(engine)) {
    const file = join(directory, name);
    if (!(await metadata(file))?.isSymbolicLink() || resolve(directory, await readlink(file)) !== join(root, name)) {
      throw new Error('槽位原生会话目录映射失效');
    }
  }
  await assertSessionStateFiles(directory, root, engine);
}
