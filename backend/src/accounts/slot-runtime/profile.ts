import { cp, lstat, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../credential-files.js';
import { pathExists, relocateHomeLinks } from '../migration-state.js';
import { accountIdentifier, userRuntimeHome, type AccountEngine } from '../paths.js';
import { sessionStateDirectories, sessionStateFiles } from '../session-state/index.js';
import { isSlotAccountEntry, moveSlotProfile, removeSeedIdentity } from './profile-files.js';
import { archiveAccountArtifacts, assertNoAccountArtifacts, isAccountArtifactPath } from './profile-artifacts.js';

interface Initialization { version: 1; slotId: string; home: string; engine: AccountEngine; phase: 'prepared' | 'complete' }
interface ProfileMarker { version: 1; userId: string; slotId: string; engine: AccountEngine; phase: 'prepared' | 'complete' }

function slotHome(dataDir: string, slotId: string, home: string): void {
  if (resolve(home) !== resolve(dataDir, 'slots', accountIdentifier(slotId))) throw new Error('固定槽位运行目录无效');
}

function profileHome(dataDir: string, userId: string, slotId: string): string {
  return join(dataDir, 'users', accountIdentifier(userId), 'slot-state', accountIdentifier(slotId), 'runtime');
}

export async function initializeSlotProfile(dataDir: string, slotId: string, home: string, engine: AccountEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  const markerFile = join(dataDir, 'accounts', 'slot-profiles-v3', `${slotId}.json`);
  const archive = join(dataDir, 'backups', 'slot-runtime-v3', slotId, 'runtime');
  const content = await readPrivateJson(markerFile);
  const marker: Initialization = content ? JSON.parse(content) as Initialization
    : { version: 1, slotId, home, engine, phase: 'prepared' };
  if (marker.version !== 1 || marker.slotId !== slotId || marker.home !== home || marker.engine !== engine
    || !['prepared', 'complete'].includes(marker.phase)) throw new Error('槽位运行目录初始化记录无效');
  if (marker.phase === 'complete') return;
  if (!content) {
    if (await pathExists(dirname(archive))) throw new Error('槽位旧配置备份已存在但缺少归属记录，已停止初始化');
    await writePrivateJson(markerFile, JSON.stringify(marker));
  }
  await archiveAccountArtifacts(dataDir, slotId, home, engine);
  // Unattributed files may belong to an earlier operator; never seed a new user's profile from this archive.
  await moveSlotProfile(home, archive, engine, 'archive');
  marker.phase = 'complete';
  await writePrivateJson(markerFile, JSON.stringify(marker));
}

function seedEntry(source: string, file: string, engine: AccountEngine): boolean {
  const within = relative(source, file);
  if (!within) return true;
  const parts = within.split(sep);
  if (isAccountArtifactPath(parts.join('/'), engine)) return false;
  const engineDirectory = engine === 'claude' ? '.claude' : '.codex';
  if (parts[0] === (engine === 'claude' ? '.codex' : '.claude') || parts[0] === '.cache'
    || ['.account-home-migration.json', '.conversation-runtime.json', '.claude.lock', '.claude.json.lock', '.claude.json.lock.owner'].includes(parts[0])) return false;
  if (engine === 'codex' && (parts[0] === '.claude.json' || parts[0].startsWith('.claude.json.'))) return false;
  if (isSlotAccountEntry(parts.join('/'), engine)) return false;
  if (parts[0] !== engineDirectory || parts.length < 2) return true;
  return !new Set([...sessionStateDirectories(engine), ...sessionStateFiles(engine), 'history.jsonl', 'session_index.jsonl', 'models_cache.json',
    'logs', 'log', 'debug', 'telemetry', 'tmp', 'backups', 'shell-snapshots', 'shell_snapshots', 'session-env', 'sessions']).has(parts[1])
    && !/\.(?:sqlite|db)(?:-(?:wal|shm))?$/.test(parts[1]);
}

async function ensureProfile(dataDir: string, userId: string, slotId: string, engine: AccountEngine): Promise<string> {
  const home = profileHome(dataDir, userId, slotId);
  const markerFile = join(dirname(home), 'profile.json');
  const content = await readPrivateJson(markerFile);
  const marker: ProfileMarker = content ? JSON.parse(content) as ProfileMarker
    : { version: 1, userId, slotId, engine, phase: 'prepared' };
  if (marker.version !== 1 || marker.userId !== userId || marker.slotId !== slotId || marker.engine !== engine
    || !['prepared', 'complete'].includes(marker.phase)) throw new Error('用户槽位配置归属记录无效');
  if (marker.phase === 'complete') { await privateDirectory(home); return home; }
  if (!content) {
    if (await pathExists(home)) throw new Error('用户槽位配置已存在但缺少归属记录');
    await writePrivateJson(markerFile, JSON.stringify(marker));
  }
  const staging = join(dirname(home), '.profile-initializing');
  if (!await pathExists(home)) {
    await rm(staging, { recursive: true, force: true });
    const source = userRuntimeHome(dataDir, userId);
    if (await pathExists(source)) {
      await privateDirectory(source);
      await cp(source, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
        filter: async file => {
          if (!seedEntry(source, file, engine)) return false;
          const entry = await lstat(file);
          return entry.isFile() || entry.isDirectory() || entry.isSymbolicLink();
        } });
      await relocateHomeLinks(staging, staging, source, home);
    }
    await privateDirectory(staging);
    await removeSeedIdentity(staging, engine);
    await rename(staging, home);
  } else {
    await privateDirectory(home);
    if (await pathExists(staging) && (await readdir(staging)).length) throw new Error('用户槽位配置初始化存在两个版本');
  }
  marker.phase = 'complete';
  await writePrivateJson(markerFile, JSON.stringify(marker));
  return home;
}

export async function restoreSlotProfile(dataDir: string, userId: string, slotId: string, home: string, engine: AccountEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  const profile = await ensureProfile(dataDir, userId, slotId, engine);
  await assertNoAccountArtifacts(profile, engine);
  await archiveAccountArtifacts(dataDir, slotId, home, engine);
  await moveSlotProfile(profile, home, engine, 'restore');
}

export async function saveSlotProfile(dataDir: string, userId: string, slotId: string, home: string, engine: AccountEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  const profile = await ensureProfile(dataDir, userId, slotId, engine);
  await archiveAccountArtifacts(dataDir, slotId, home, engine);
  await moveSlotProfile(home, profile, engine, 'save');
}
