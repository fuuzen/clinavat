import { chmod, lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../database.js';
import type { Host, Project } from '../models.js';
import { atomicWrite, checkedCommand } from './process.js';
import { SshManager } from './ssh.js';
import { summarizeSyncFailure } from './sync-status.js';
import { assertIdentifier, type RuntimeConfig } from './types.js';

interface NativeSessionSnapshot {
  id: string;
  native_session_id: string | null;
  jsonl_file_path: string | null;
}

export interface WorkspaceMigration {
  projectId: string;
  oldPath: string;
  newPath: string;
  phase: 'prepared' | 'moved' | 'complete';
  previousStatus: string;
  wasPaused: boolean;
  sessionInspected?: boolean;
  flushed: boolean;
  reusable: boolean;
  restored?: boolean;
  nativeSessions: NativeSessionSnapshot[];
  error?: string;
}

async function metadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

export function migrationPath(config: RuntimeConfig, projectId: string): string {
  assertIdentifier(projectId);
  return join(config.dataDir, 'workspace-migrations', `${projectId}.json`);
}

export async function readWorkspaceMigration(config: RuntimeConfig, projectId: string): Promise<WorkspaceMigration | undefined> {
  const path = migrationPath(config, projectId);
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!content) return undefined;
  const migration = JSON.parse(content) as WorkspaceMigration;
  if (migration.projectId !== projectId || !['prepared', 'moved', 'complete'].includes(migration.phase)
    || typeof migration.oldPath !== 'string' || typeof migration.newPath !== 'string'
    || typeof migration.flushed !== 'boolean' || typeof migration.reusable !== 'boolean') {
    throw new Error(`工作区迁移记录无效：${projectId}`);
  }
  return migration;
}

export async function saveWorkspaceMigration(config: RuntimeConfig, migration: WorkspaceMigration): Promise<void> {
  await mkdir(join(config.dataDir, 'workspace-migrations'), { recursive: true, mode: 0o700 });
  await atomicWrite(migrationPath(config, migration.projectId), `${JSON.stringify(migration, null, 2)}\n`);
}

async function retireSession(config: RuntimeConfig, ssh: SshManager, project: Project, migration: WorkspaceMigration): Promise<void> {
  const environment = await ssh.mutagenEnvironment(project.user_id);
  const mutagen = (args: string[], timeout = 30_000) => checkedCommand(config.mutagenBinary ?? 'mutagen', args, {
    env: environment, timeout,
  });
  let sessions: { paused?: boolean }[];
  try {
    const result = await mutagen(['sync', 'list', project.sync_name, '--template', '{{json .}}']);
    sessions = JSON.parse(result.stdout) as { paused?: boolean }[];
    if (!Array.isArray(sessions) || sessions.length > 1) throw new Error('无法识别原工作区同步会话');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(`specification "${project.sync_name}" did not match any sessions`)) throw error;
    sessions = [];
  }
  if (!sessions.length) return;
  if (migration.previousStatus === 'ERROR' && migration.nativeSessions.length === 0) {
    // An uninitialized mirror must never push an incomplete first scan back into the source tree.
    await mutagen(['sync', 'terminate', project.sync_name]);
    migration.reusable = false;
    await saveWorkspaceMigration(config, migration);
    return;
  }
  if (!migration.sessionInspected) {
    migration.wasPaused = sessions[0].paused === true;
    migration.sessionInspected = true;
  }
  await saveWorkspaceMigration(config, migration);
  try {
    await mutagen(['sync', 'resume', project.sync_name]);
    await mutagen(['sync', 'flush', project.sync_name], 120_000);
  } catch (error) {
    const diagnostic = await mutagen(['sync', 'list', project.sync_name, '--template', '{{json .}}'], 10_000)
      .then(result => summarizeSyncFailure(result.stdout)).catch(() => '');
    if (migration.wasPaused) await mutagen(['sync', 'pause', project.sync_name]).catch(() => undefined);
    throw new Error(`迁移前同步未完成，保留原目录和同步会话：${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  migration.flushed = true;
  migration.reusable = true;
  await saveWorkspaceMigration(config, migration);
  await mutagen(['sync', 'pause', project.sync_name]);
  await mutagen(['sync', 'terminate', project.sync_name]);
}

export async function migrateWorkspaces(config: RuntimeConfig, store: Store, ssh: SshManager): Promise<WorkspaceMigration[]> {
  const workspaceRoot = resolve(config.workspaceDir);
  const legacyRoot = resolve(config.dataDir, 'workspaces');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(workspaceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || await realpath(workspaceRoot) !== workspaceRoot) {
    throw new Error('工作区根目录必须是实际目录，不能通过符号链接访问');
  }
  if (process.getuid && rootMetadata.uid !== process.getuid()) throw new Error('工作区根目录不属于当前服务用户');
  await chmod(workspaceRoot, 0o700);
  const projects = store.all<Project>("SELECT * FROM projects WHERE execution_mode IS NULL OR execution_mode<>'local' ORDER BY created_at,id");
  const pending = projects.filter(project => resolve(project.local_path) !== join(workspaceRoot, `proj_${project.id}`));
  if (pending.length) {
    const backups = join(config.dataDir, 'backups');
    await mkdir(backups, { recursive: true, mode: 0o700 });
    store.run('VACUUM INTO ?', join(backups, `workspace-migration-${Date.now()}.sqlite`));
  }
  const results: WorkspaceMigration[] = [];
  for (const project of projects) {
    assertIdentifier(project.id);
    const newPath = join(workspaceRoot, `proj_${project.id}`);
    const existing = await readWorkspaceMigration(config, project.id);
    if (resolve(project.local_path) === newPath && (!existing || existing.phase === 'complete')) {
      if (existing) results.push(existing);
      continue;
    }
    const oldPath = join(legacyRoot, `proj_${project.id}`);
    if (resolve(project.local_path) !== oldPath && resolve(project.local_path) !== newPath) {
      throw new Error(`工作区不在预期的旧目录内，拒绝自动迁移：${project.id}`);
    }
    const migration: WorkspaceMigration = existing ?? {
      projectId: project.id, oldPath, newPath, phase: 'prepared',
      previousStatus: project.sync_status, wasPaused: project.sync_status === 'PAUSED',
      flushed: false, reusable: false,
      nativeSessions: store.all<NativeSessionSnapshot>('SELECT id,native_session_id,jsonl_file_path FROM sessions WHERE project_id=?', project.id),
    };
    if (migration.oldPath !== oldPath || migration.newPath !== newPath) throw new Error(`工作区迁移记录与配置不一致：${project.id}`);
    try {
      delete migration.error;
      await saveWorkspaceMigration(config, migration);
      if (migration.phase === 'prepared') {
        const host = store.get<Host>('SELECT * FROM dev_hosts WHERE id=? AND user_id=?', project.dev_host_id, project.user_id);
        if (!host) throw new Error('找不到工作区对应的开发机');
        await ssh.addHost(project.user_id, host);
        await retireSession(config, ssh, project, migration);
        const [oldMetadata, newMetadata] = await Promise.all([metadata(oldPath), metadata(newPath)]);
        if (oldMetadata && newMetadata) throw new Error('新旧工作区目录同时存在，保留两者并停止自动迁移');
        if (oldMetadata) {
          if (!oldMetadata.isDirectory() || oldMetadata.isSymbolicLink()) throw new Error('旧工作区不是实际目录');
          // Rename preserves the full mirror without a second copy on nearly full disks.
          await rename(oldPath, newPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'EXDEV') throw new Error('新旧工作区不在同一文件系统，无法原地迁移；请先准备足够空间后离线迁移');
            throw error;
          });
        } else if (!newMetadata) await mkdir(newPath, { mode: 0o700 });
        else if (!newMetadata.isDirectory() || newMetadata.isSymbolicLink()) throw new Error('目标工作区不是实际目录');
        migration.phase = 'moved';
        await saveWorkspaceMigration(config, migration);
      }
      if (migration.phase === 'moved') {
        store.transaction(() => {
          store.run("UPDATE projects SET local_path=?,sync_status='PAUSED' WHERE id=?", newPath, project.id);
          // Native sessions retain old cwd snapshots; web history and original native references remain archived.
          store.run("UPDATE sessions SET native_session_id=NULL,jsonl_file_path=NULL,updated_at=datetime('now') WHERE project_id=?", project.id);
        });
        migration.phase = 'complete';
        await saveWorkspaceMigration(config, migration);
      }
    } catch (error) {
      migration.error = error instanceof Error ? error.message : String(error);
      store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
      await saveWorkspaceMigration(config, migration);
    }
    results.push(migration);
  }
  return results;
}
