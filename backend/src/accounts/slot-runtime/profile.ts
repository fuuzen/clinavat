import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../credential-files.js';
import { accountIdentifier } from '../paths.js';
import { moveSlotProfile, pathExists } from './profile-files.js';
import { archiveAccountArtifacts, assertNoAccountArtifacts } from './profile-artifacts.js';
import { ensureClaudeSlotIdentity } from '../claude-identity.js';
import { metadata } from '../session-state/files.js';
import { engineDirectory, sessionStateDirectories, sessionStateFiles } from '../session-state/layout.js';
import { engineProfiles, type AgentEngine } from '../../agent/engines.js';

interface Initialization { version: 1; slotId: string; home: string; engine: AgentEngine; phase: 'prepared' | 'complete' }
interface ProfileMarker { version: 1; userId: string; slotId: string; engine: AgentEngine }

function slotHome(dataDir: string, slotId: string, home: string): void {
  if (resolve(home) !== resolve(dataDir, 'slots', accountIdentifier(slotId))) throw new Error('固定槽位运行目录无效');
}

function profileHome(dataDir: string, userId: string, slotId: string): string {
  return join(dataDir, 'users', accountIdentifier(userId), 'slot-state', accountIdentifier(slotId), 'runtime');
}

async function assertUnboundSessionState(home: string, engine: AgentEngine): Promise<void> {
  if (await pathExists(join(home, '.slot-session-state.json'))) throw new Error('槽位仍有原生会话映射记录，已停止归档未归属配置');
  for (const name of [...sessionStateDirectories(engine), ...sessionStateFiles(engine)]) {
    if ((await metadata(join(engineDirectory(home, engine), name)))?.isSymbolicLink()) {
      throw new Error('槽位仍有原生会话映射，已停止归档未归属配置');
    }
  }
}

export async function initializeSlotProfile(dataDir: string, slotId: string, home: string, engine: AgentEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  await assertUnboundSessionState(home, engine);
  if (engine === 'claude') await ensureClaudeSlotIdentity(dataDir, slotId, home);
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

/** Login and diagnostic CLIs can create runtime files after the previous user's profile was saved. */
export async function archiveUnboundSlotProfile(dataDir: string, slotId: string, home: string, engine: AgentEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  await assertUnboundSessionState(home, engine);
  const directory = join(dataDir, 'backups', 'slot-unbound-runtime', slotId, randomUUID());
  const runtime = join(directory, 'runtime');
  await writePrivateJson(join(directory, 'source.json'), JSON.stringify({ version: 1, slotId, home, engine, createdAt: new Date().toISOString() }));
  await archiveAccountArtifacts(dataDir, slotId, home, engine);
  await moveSlotProfile(home, runtime, engine, 'archive');
  const entries = await readdir(runtime);
  const engineName = engineProfiles[engine].configDirectory;
  const onlyEmptyEngine = entries.length === 1 && entries[0] === engineName
    && (await readdir(join(runtime, engineName))).length === 0;
  if (!entries.length || onlyEmptyEngine) await rm(directory, { recursive: true });
}

async function ensureProfile(dataDir: string, userId: string, slotId: string, engine: AgentEngine): Promise<string> {
  const home = profileHome(dataDir, userId, slotId);
  const markerFile = join(dirname(home), 'profile.json');
  const content = await readPrivateJson(markerFile);
  if (content) {
    const marker = JSON.parse(content) as ProfileMarker;
    if (marker.version !== 1 || marker.userId !== userId || marker.slotId !== slotId || marker.engine !== engine) {
      throw new Error('用户槽位配置归属记录无效');
    }
  } else {
    if (await pathExists(home)) throw new Error('用户槽位配置已存在但缺少归属记录');
    await writePrivateJson(markerFile, JSON.stringify({ version: 1, userId, slotId, engine } satisfies ProfileMarker));
  }
  await privateDirectory(home);
  return home;
}

export async function restoreSlotProfile(dataDir: string, userId: string, slotId: string, home: string, engine: AgentEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  const profile = await ensureProfile(dataDir, userId, slotId, engine);
  if (engine === 'claude') await ensureClaudeSlotIdentity(dataDir, slotId, home, profile);
  await assertNoAccountArtifacts(profile, engine);
  await archiveAccountArtifacts(dataDir, slotId, home, engine);
  await moveSlotProfile(profile, home, engine, 'restore');
}

export async function saveSlotProfile(dataDir: string, userId: string, slotId: string, home: string, engine: AgentEngine): Promise<void> {
  slotHome(dataDir, slotId, home);
  const profile = await ensureProfile(dataDir, userId, slotId, engine);
  if (engine === 'claude') await ensureClaudeSlotIdentity(dataDir, slotId, home, profile);
  await archiveAccountArtifacts(dataDir, slotId, home, engine);
  await moveSlotProfile(home, profile, engine, 'save');
}
