import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite } from './process.js';
import { assertIdentifier, type RuntimeConfig, type WorkspaceProject } from './types.js';

interface ArchiveEntry {
  source: string;
  target: string;
  status: 'pending' | 'moving' | 'archived';
}

async function metadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

function sourcePaths(paths: string[]): string[] {
  const normalized = paths.map(path => {
    if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('归档路径必须是项目相对路径');
    const parts = path.replace(/\/$/, '').split('/');
    if (parts.some(part => part === '..' || part === '.bin')) throw new Error('归档路径越界或指向运行时文件');
    const clean = parts.filter(part => part && part !== '.').join('/');
    if (!clean) throw new Error('不能归档整个工作区');
    return clean;
  });
  const ordered = [...new Set(normalized)].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const selected: string[] = [];
  for (const path of ordered) {
    if (!selected.some(parent => path.startsWith(`${parent}/`))) selected.push(path);
  }
  return selected;
}

async function safeSource(root: string, path: string): Promise<string | undefined> {
  const parts = path.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const value = await metadata(current);
    if (!value) return undefined;
    if (index < parts.length - 1 && (!value.isDirectory() || value.isSymbolicLink())) {
      throw new Error(`归档路径经过符号链接或非目录：${path}`);
    }
  }
  return current;
}

export async function archiveIgnoredMirror(config: RuntimeConfig, project: WorkspaceProject, paths: string[]): Promise<void> {
  assertIdentifier(project.id);
  const relativePaths = sourcePaths(paths);
  if (!relativePaths.length) return;
  const root = resolve(project.local_path);
  const expectedRoot = join(resolve(config.workspaceDir), `proj_${project.id}`);
  if (root !== expectedRoot || await realpath(root) !== root) throw new Error('镜像归档必须位于实际受管工作区内');
  const sources: { path: string; source: string }[] = [];
  for (const path of relativePaths) {
    const source = await safeSource(root, path);
    if (source) sources.push({ path, source });
  }
  if (!sources.length) return;

  const archiveParent = join(config.dataDir, 'backups', 'workspace-files');
  await mkdir(archiveParent, { recursive: true, mode: 0o700 });
  const archiveRoot = join(archiveParent, `${project.id}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const child = relative(root, resolve(archiveRoot));
  if (!child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) {
    throw new Error('镜像归档目录不能位于源工作区内');
  }
  await mkdir(archiveRoot, { mode: 0o700 });
  if (await realpath(archiveRoot) !== resolve(archiveRoot)) throw new Error('镜像归档目录不能通过符号链接访问');
  const entries: ArchiveEntry[] = sources.map(item => ({ source: item.source, target: join(archiveRoot, 'files', item.path), status: 'pending' }));
  const manifestPath = join(archiveRoot, 'manifest.json');
  const manifest = { projectId: project.id, workspace: root, createdAt: new Date().toISOString(), entries, error: undefined as string | undefined };
  const save = () => atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await save();
  try {
    for (const [index, entry] of entries.entries()) {
      if (await safeSource(root, sources[index].path) !== entry.source) throw new Error(`待归档文件在操作期间消失：${sources[index].path}`);
      await mkdir(dirname(entry.target), { recursive: true, mode: 0o700 });
      entry.status = 'moving';
      await save();
      await rename(entry.source, entry.target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EXDEV') throw new Error('归档目录与工作区不在同一文件系统，已保留原文件');
        throw error;
      });
      entry.status = 'archived';
      await save();
    }
  } catch (error) {
    manifest.error = error instanceof Error ? error.message : String(error);
    await save().catch(() => undefined);
    throw new Error(`镜像归档未完成，已保留操作清单 ${manifestPath}：${manifest.error}`);
  }
}
