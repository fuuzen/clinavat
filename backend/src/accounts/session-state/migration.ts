import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Store } from '../../database.js';
import type { Session } from '../../models.js';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../credential-files.js';
import { accountIdentifier, sessionRuntimeHome, userRuntimeHome, type AccountEngine } from '../paths.js';
import { copyState, directoryEntries, metadata, regularFiles } from './files.js';
import { assertEmptyLegacyGoalDatabase } from './goal-files.js';
import { engineDirectory, sessionStateDirectories, userSessionStateRoot } from './layout.js';

interface MigrationMarker {
  version: 1;
  userId: string;
  engine: AccountEngine;
  sessionPaths: Record<string, string>;
}

const initializing = new Map<string, Promise<void>>();
const markerName = '.session-state.json';

async function legacyEngineDirectory(home: string, engine: AccountEngine): Promise<string> {
  for (const directory of [home, engineDirectory(home, engine)]) {
    const entry = await metadata(directory);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error('旧会话运行目录必须是实际目录，已停止迁移');
    }
  }
  return engineDirectory(home, engine);
}

async function sessionFiles(source: string, engine: AccountEngine, nativeId: string): Promise<string[]> {
  const roots = engine === 'claude' ? ['projects'] : ['sessions', 'archived_sessions'];
  const files: string[] = [];
  for (const root of roots) {
    for (const file of await regularFiles(join(source, root))) {
      const name = basename(file);
      if (engine === 'claude' ? name === `${nativeId}.jsonl` : name.endsWith(`-${nativeId}.jsonl`)) files.push(file);
    }
  }
  return files;
}

async function copyOwnedSession(source: string, target: string, engine: AccountEngine, nativeId: string): Promise<string | undefined> {
  const files = await sessionFiles(source, engine, nativeId);
  if (files.length > 1) throw new Error('同一原生会话存在多个历史副本，已保留原目录并停止迁移');
  const transcript = files[0];
  if (!transcript) return undefined;
  const transcriptPath = relative(source, transcript);
  for (const previous of await sessionFiles(target, engine, nativeId)) {
    if (previous === join(target, transcriptPath)) continue;
    await rm(previous);
    if (engine === 'claude') await rm(join(dirname(previous), nativeId), { recursive: true, force: true });
  }
  await copyState(transcript, join(target, transcriptPath), true);
  if (engine === 'claude') {
    await copyState(join(dirname(transcript), nativeId), join(dirname(join(target, transcriptPath)), nativeId), true);
    await copyState(join(dirname(transcript), 'memory'), join(dirname(join(target, transcriptPath)), 'memory'));
    for (const root of ['file-history', 'tasks']) await copyState(join(source, root, nativeId), join(target, root, nativeId), true);
    for (const name of await directoryEntries(join(source, 'todos'))) {
      if (name === nativeId || name.startsWith(`${nativeId}-`) || name.startsWith(`${nativeId}.`)) {
        await copyState(join(source, 'todos', name), join(target, 'todos', name), true);
      }
    }
  }
  return transcriptPath;
}

function restoreSessionPaths(store: Store, root: string, marker: MigrationMarker): void {
  for (const [id, saved] of Object.entries(marker.sessionPaths)) {
    accountIdentifier(id);
    const file = resolve(root, saved);
    const within = relative(root, file);
    if (within === '..' || within.startsWith(`..${sep}`) || within.startsWith(sep)) {
      throw new Error('原生会话迁移记录含非法路径');
    }
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=? AND user_id=? AND engine=?', id, marker.userId, marker.engine);
    // Once a conversation has run in the shared store, its callback owns the current path.
    if (!session || (session.jsonl_file_path && !session.jsonl_file_path.includes(`${sep}runtime${sep}`))) continue;
    store.run('UPDATE sessions SET jsonl_file_path=? WHERE id=? AND user_id=? AND engine=?', file, id, marker.userId, marker.engine);
  }
}

async function initialize(dataDir: string, store: Store, userId: string, engine: AccountEngine, root: string): Promise<void> {
  if (engine === 'codex') {
    const homes = [userRuntimeHome(dataDir, userId), ...store.all<Pick<Session, 'id'>>(
      'SELECT id FROM sessions WHERE user_id=? AND engine=?', userId, engine,
    ).map(session => sessionRuntimeHome(dataDir, userId, session.id))];
    for (const home of homes) {
      const directory = await legacyEngineDirectory(home, engine);
      await assertEmptyLegacyGoalDatabase(join(directory, 'goals_1.sqlite'));
    }
    await assertEmptyLegacyGoalDatabase(join(root, 'sqlite', 'goals_1.sqlite'));
  }
  const previous = await readPrivateJson(join(root, markerName));
  if (previous) {
    const marker = JSON.parse(previous) as MigrationMarker;
    if (marker.version !== 1 || marker.userId !== userId || marker.engine !== engine || !marker.sessionPaths) {
      throw new Error('用户原生会话存储归属记录无效');
    }
    await privateDirectory(root);
    restoreSessionPaths(store, root, marker);
    return;
  }
  if (await metadata(root)) throw new Error('用户原生会话目录已存在但缺少归属记录，拒绝覆盖');
  await privateDirectory(dirname(root));
  const staging = join(dirname(root), `.initializing-${engine}`);
  await rm(staging, { recursive: true, force: true });
  await privateDirectory(staging);
  const sessions = store.all<Session>('SELECT * FROM sessions WHERE user_id=? AND engine=?', userId, engine);
  const nativeIds = new Set<string>();
  const base = await legacyEngineDirectory(userRuntimeHome(dataDir, userId), engine);
  for (const name of sessionStateDirectories(engine)) {
    if (name !== 'thread-writer-locks') await copyState(join(base, name), join(staging, name));
    await privateDirectory(join(staging, name));
  }
  const marker: MigrationMarker = { version: 1, userId, engine, sessionPaths: {} };
  for (const session of sessions) {
    if (!session.native_session_id) continue;
    const nativeId = accountIdentifier(session.native_session_id);
    if (nativeIds.has(nativeId)) throw new Error('多个对话使用相同原生会话 ID，已停止迁移以避免并发覆盖');
    nativeIds.add(nativeId);
    const source = await legacyEngineDirectory(sessionRuntimeHome(dataDir, userId, session.id), engine);
    const copied = await copyOwnedSession(source, staging, engine, nativeId);
    const candidates = copied ? [] : await sessionFiles(staging, engine, nativeId);
    if (candidates.length > 1) throw new Error('旧用户目录存在重复的原生会话历史，已停止迁移');
    const fallback = candidates[0];
    if (!copied && !fallback) throw new Error(`对话 ${session.id} 缺少原生历史，已保留原目录并停止迁移`);
    marker.sessionPaths[session.id] = copied ?? relative(staging, fallback!);
    if (engine === 'claude' && copied) {
      for (const name of ['plans', 'paste-cache']) await copyState(join(source, name), join(staging, name));
    }
  }
  await writePrivateJson(join(staging, markerName), JSON.stringify(marker));
  await rename(staging, root);
  restoreSessionPaths(store, root, marker);
}

export async function ensureUserSessionState(dataDir: string, store: Store, userId: string, engine: AccountEngine): Promise<string> {
  const root = userSessionStateRoot(dataDir, userId, engine);
  let pending = initializing.get(root);
  if (!pending) {
    pending = initialize(dataDir, store, userId, engine, root).finally(() => initializing.delete(root));
    initializing.set(root, pending);
  }
  await pending;
  return root;
}
