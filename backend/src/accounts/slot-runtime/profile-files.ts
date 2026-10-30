import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../credential-files.js';
import { pathExists, relocateHomeLinks } from '../migration-state.js';
import type { AccountEngine } from '../paths.js';
import { sessionStateDirectories, sessionStateFiles } from '../session-state/index.js';

type Document = Record<string, unknown>;
type Transfer = 'archive' | 'save' | 'restore';

const claudeIdentityKeys = [
  'oauthAccount', 'primaryApiKey', 'customApiKeyResponses', 'userID',
  'hasCompletedOnboarding', 'lastOnboardingVersion',
];
const mixedFiles = [
  { path: '.claude.json', keys: claudeIdentityKeys },
  { path: join('.claude', '.claude.json'), keys: claudeIdentityKeys },
  { path: join('.claude', '.credentials.json'), keys: ['claudeAiOauth'] },
];

async function documentAt(file: string): Promise<Document> {
  const content = await readPrivateJson(file);
  return content ? JSON.parse(content) as Document : {};
}

async function saveDocument(file: string, document: Document): Promise<void> {
  const previous = await documentAt(file);
  if (isDeepStrictEqual(previous, document)) return;
  if (Object.keys(document).length) await writePrivateJson(file, JSON.stringify(document));
  else await rm(file, { force: true });
}

function separate(document: Document, keys: string[]): { account: Document; user: Document } {
  const account: Document = {}, user: Document = {};
  for (const [key, value] of Object.entries(document)) (keys.includes(key) ? account : user)[key] = value;
  return { account, user };
}

async function transferMixed(source: string, target: string, keys: string[], direction: Transfer): Promise<void> {
  const from = separate(await documentAt(source), keys);
  const to = separate(await documentAt(target), keys);
  const profile = direction === 'restore' ? from : to;
  if (Object.keys(profile.account).length) throw new Error('用户槽位配置中包含账号身份字段，已阻止覆盖');
  if (!Object.keys(from.user).length) return;
  if (Object.keys(to.user).length && !isDeepStrictEqual(from.user, to.user)) {
    throw new Error('用户槽位配置存在未完成的不同版本，已保留两份数据');
  }
  // Save the user fragment before removing it from its former location, so a retry can finish safely.
  await saveDocument(target, { ...to.account, ...from.user });
  await saveDocument(source, from.account);
}

function protectedEngineEntry(name: string, engine: AccountEngine): boolean {
  return engine === 'codex'
    ? ['auth.json', 'auth.json.lock', 'auth.json.lock.owner', '.auth.json.lock', '.auth-refresh.lock'].includes(name)
    : ['.credentials.json', '.claude.json', '.oauth_refresh.lock', '.oauth_refresh.lock.owner',
      '.credentials.json.lock', '.credentials.json.lock.owner', '.claude.json.lock', '.claude.json.lock.owner',
      '.storage-write', '.storage-write.lock'].includes(name);
}

async function moveEntry(source: string, target: string): Promise<void> {
  if (await pathExists(target)) throw new Error(`槽位配置迁移目标已存在，拒绝覆盖：${target}`);
  await privateDirectory(dirname(target));
  await rename(source, target);
}

async function transferEngine(source: string, target: string, engine: AccountEngine, direction: Transfer): Promise<void> {
  if (!await pathExists(source)) return;
  await privateDirectory(source);
  await privateDirectory(target);
  const sessions = new Set(sessionStateDirectories(engine));
  const sharedFiles = new Set(sessionStateFiles(engine));
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (protectedEngineEntry(entry.name, engine)) {
      if (direction === 'restore' && !(engine === 'claude' && ['.credentials.json', '.claude.json'].includes(entry.name))) {
        throw new Error('用户槽位配置包含受保护的账号文件或锁，已停止恢复');
      }
      continue;
    }
    if (direction !== 'archive' && (sessions.has(entry.name)
      || (sharedFiles.has(entry.name) && (direction === 'save' || entry.isSymbolicLink())))) {
      throw new Error('原生会话存储尚未卸载，已停止槽位配置迁移');
    }
    await moveEntry(join(source, entry.name), join(target, entry.name));
  }
}

export async function moveSlotProfile(source: string, target: string, engine: AccountEngine, direction: Transfer): Promise<void> {
  await privateDirectory(source);
  await privateDirectory(target);
  const engineDirectory = engine === 'claude' ? '.claude' : '.codex';
  await transferEngine(join(source, engineDirectory), join(target, engineDirectory), engine, direction);
  if (engine === 'claude') {
    for (const file of mixedFiles) await transferMixed(join(source, file.path), join(target, file.path), file.keys, direction);
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === engineDirectory || (engine === 'claude' && entry.name === '.claude.json')) continue;
    if (engine === 'claude' && ['.claude.lock', '.claude.json.lock', '.claude.json.lock.owner'].includes(entry.name)) {
      if (direction === 'restore') throw new Error('用户槽位配置包含受保护的账号锁');
      continue;
    }
    await moveEntry(join(source, entry.name), join(target, entry.name));
  }
  await relocateHomeLinks(target, target, source, target);
}

export async function removeSeedIdentity(home: string, engine: AccountEngine): Promise<void> {
  if (engine === 'codex') {
    await rm(join(home, '.codex', 'auth.json'), { force: true });
    return;
  }
  for (const file of mixedFiles) {
    const source = join(home, file.path);
    const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) { await rm(source); continue; }
    await saveDocument(source, separate(await documentAt(source), file.keys).user);
  }
}

export function isSlotAccountEntry(relativePath: string, engine: AccountEngine): boolean {
  const prefix = engine === 'claude' ? '.claude/' : '.codex/';
  return relativePath.startsWith(prefix) && protectedEngineEntry(relativePath.slice(prefix.length), engine)
    && !['.claude/.credentials.json', '.claude/.claude.json'].includes(relativePath);
}
