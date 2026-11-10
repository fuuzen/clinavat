import { randomBytes } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { accountIdentifier } from './paths.js';
import { readPrivateJson, writePrivateJson } from './credential-files.js';
import { openContainedDirectory, placeFile } from '../runtime/contained-files.js';

export const claudeInstallationKeys = ['machineID', 'firstStartTime', 'firstStartVersion'] as const;

type Document = Record<string, unknown>;
interface Installation extends Document { machineID: string; firstStartTime: string; firstStartVersion?: string }
interface IdentityRecord { version: 1; slotId: string; home: string; installation: Installation }
interface Candidate { installation: Installation; mtime: number }

const queues = new Map<string, Promise<void>>();
const configPaths = [join('.claude', '.claude.json'), '.claude.json'];

function installationFrom(document: Document): Installation | undefined {
  if (typeof document.machineID !== 'string' || !/^[a-f\d]{64}$/i.test(document.machineID)) return undefined;
  const firstStartTime = typeof document.firstStartTime === 'string' && !Number.isNaN(Date.parse(document.firstStartTime))
    ? document.firstStartTime : new Date().toISOString();
  return {
    machineID: document.machineID, firstStartTime,
    ...(typeof document.firstStartVersion === 'string' && document.firstStartVersion
      ? { firstStartVersion: document.firstStartVersion } : {}),
  };
}

async function readDocument(dataDir: string, file: string): Promise<{ content: string; document: Document } | undefined> {
  const content = await readPrivateJson(file, dataDir);
  return content === undefined ? undefined : { content, document: JSON.parse(content) as Document };
}

async function writeDocument(dataDir: string, file: string, content: string): Promise<void> {
  const directory = await openContainedDirectory(dataDir, relative(dataDir, dirname(file)).split(sep), true);
  const staging = join(dataDir, 'accounts', 'slot-cli-identities', `.write-${randomBytes(12).toString('hex')}.json`);
  try {
    await directory.handle.chmod(0o700);
    await writePrivateJson(staging, content);
    await placeFile(directory.handle, basename(file), staging, true);
  } finally {
    await directory.handle.close();
    await rm(staging, { force: true });
  }
}

async function candidates(dataDir: string, home: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const configPath of configPaths) {
    const file = join(home, configPath);
    const document = await readDocument(dataDir, file);
    const installation = document && installationFrom(document.document);
    if (!installation) continue;
    const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata) found.push({ installation, mtime: metadata.mtimeMs });
  }
  return found;
}

async function validateProfile(dataDir: string, slotId: string, profileHome: string): Promise<void> {
  const parts = relative(dataDir, profileHome).split(sep);
  if (parts.length !== 5 || parts[0] !== 'users' || parts[2] !== 'slot-state'
    || parts[3] !== slotId || parts[4] !== 'runtime') throw new Error('Claude 槽位运行配置路径无效');
  const userId = accountIdentifier(parts[1]);
  const marker = await readDocument(dataDir, join(dirname(profileHome), 'profile.json'));
  if (!marker || marker.document.version !== 1 || marker.document.userId !== userId
    || marker.document.slotId !== slotId || marker.document.engine !== 'claude') {
    throw new Error('Claude 槽位运行配置归属无效');
  }
}

async function historicalInstallation(dataDir: string, slotId: string): Promise<Installation | undefined> {
  const users = await readdir(join(dataDir, 'users'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const historical: Candidate[] = [];
  for (const user of users) {
    if (!user.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(user.name)) continue;
    const home = join(dataDir, 'users', user.name, 'slot-state', slotId, 'runtime');
    const marker = await readDocument(dataDir, join(dirname(home), 'profile.json'));
    if (!marker || marker.document.version !== 1 || marker.document.userId !== user.name
      || marker.document.slotId !== slotId || marker.document.engine !== 'claude') continue;
    historical.push(...await candidates(dataDir, home));
  }
  return historical.sort((left, right) => right.mtime - left.mtime)[0]?.installation;
}

async function retainInSlot(dataDir: string, home: string, installation: Installation): Promise<void> {
  for (const [index, configPath] of configPaths.entries()) {
    const file = join(home, configPath);
    const current = await readDocument(dataDir, file);
    if (!current && index !== 0) continue;
    const next = { ...current?.document };
    for (const key of claudeInstallationKeys) delete next[key];
    Object.assign(next, installation);
    if (!isDeepStrictEqual(next, current?.document)) await writeDocument(dataDir, file, JSON.stringify(next));
  }
}

async function migrateProfile(dataDir: string, slotId: string, home: string): Promise<void> {
  let archive: string | undefined;
  for (const configPath of configPaths) {
    const file = join(home, configPath);
    const current = await readDocument(dataDir, file);
    if (!current || !claudeInstallationKeys.some(key => key in current.document)) continue;
    archive ??= join(dataDir, 'backups', 'slot-cli-identities', slotId, randomBytes(12).toString('hex'));
    // Archive the full original before extracting installation fields from a legacy user profile.
    await writePrivateJson(join(archive, relative(dataDir, file)), current.content);
    const next = { ...current.document };
    for (const key of claudeInstallationKeys) delete next[key];
    await writeDocument(dataDir, file, JSON.stringify(next));
  }
}

function identityFile(dataDir: string, slotId: string, home: string): string {
  if (home !== resolve(dataDir, 'slots', slotId)) throw new Error('Claude 固定槽位目录无效');
  return join(dataDir, 'accounts', 'slot-cli-identities', `${slotId}.json`);
}

async function readInstallation(dataDir: string, slotId: string, home: string): Promise<Installation | undefined> {
  const saved = await readDocument(dataDir, identityFile(dataDir, slotId, home));
  if (!saved) return undefined;
  const record = saved.document;
  const value = record.installation;
  if (record.version !== 1 || record.slotId !== slotId || record.home !== home
    || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude 槽位机器身份记录无效');
  const parsed = installationFrom(value as Document);
  if (!parsed || !isDeepStrictEqual(parsed, value)) throw new Error('Claude 槽位机器身份内容无效');
  return parsed;
}

async function ensureIdentity(dataDir: string, slotId: string, home: string, profileHome?: string): Promise<Installation> {
  const file = identityFile(dataDir, slotId, home);
  if (profileHome) await validateProfile(dataDir, slotId, profileHome);
  const saved = await readInstallation(dataDir, slotId, home);
  const slotCandidates = await candidates(dataDir, home);
  let installation = saved ?? slotCandidates[0]?.installation
    ?? (profileHome ? (await candidates(dataDir, profileHome))[0]?.installation : undefined)
    ?? await historicalInstallation(dataDir, slotId)
    ?? { machineID: randomBytes(32).toString('hex'), firstStartTime: new Date().toISOString() };
  if (saved && !saved.firstStartVersion) {
    const version = slotCandidates.find(candidate => candidate.installation.machineID === saved.machineID
      && candidate.installation.firstStartVersion)?.installation.firstStartVersion;
    if (version) installation = { ...saved, firstStartVersion: version };
  }
  if (!saved || !isDeepStrictEqual(saved, installation)) {
    const record: IdentityRecord = { version: 1, slotId, home, installation };
    await writePrivateJson(file, JSON.stringify(record));
  }
  await retainInSlot(dataDir, home, installation);
  if (profileHome) await migrateProfile(dataDir, slotId, profileHome);
  return { ...installation };
}

/** Busy probes read the canonical identity without writing any configuration used by a running CLI. */
export async function readClaudeSlotIdentity(dataDir: string, slotId: string, home: string): Promise<Record<string, unknown>> {
  const root = resolve(dataDir);
  const id = accountIdentifier(slotId);
  await queues.get(`${root}:${id}`);
  const installation = await readInstallation(root, id, resolve(home));
  if (!installation) throw new Error('Claude 槽位机器身份尚未准备，请等待槽位空闲后重试');
  return { ...installation };
}

/** Slot installation identity stays in the slot even while a user's runtime profile is archived. */
export async function ensureClaudeSlotIdentity(dataDir: string, slotId: string, home: string,
  profileHome?: string): Promise<Record<string, unknown>> {
  const root = resolve(dataDir);
  const id = accountIdentifier(slotId);
  const key = `${root}:${id}`;
  const work = (queues.get(key) ?? Promise.resolve()).then(() => ensureIdentity(root, id, resolve(home),
    profileHome ? resolve(profileHome) : undefined));
  const tail = work.then(() => undefined, () => undefined);
  queues.set(key, tail);
  try { return await work; }
  finally { if (queues.get(key) === tail) queues.delete(key); }
}
