import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { privateDirectory } from '../credential-files.js';
import { accountIdentifier, type AccountEngine } from '../paths.js';

function artifactName(name: string, engine: AccountEngine, root: boolean): boolean {
  const bases = root ? engine === 'claude' ? ['.claude.json'] : []
    : engine === 'claude' ? ['.credentials.json', '.claude.json'] : ['auth.json'];
  return bases.some(base => name.startsWith(`${base}.`) && ![`${base}.lock`, `${base}.lock.owner`].includes(name));
}

export function isAccountArtifactPath(file: string, engine: AccountEngine): boolean {
  const parts = file.split('/');
  if (parts.length === 1) return artifactName(parts[0], engine, true);
  if (parts[0] !== (engine === 'claude' ? '.claude' : '.codex')) return false;
  return (parts.length === 2 || parts[1] === 'backups') && artifactName(parts.at(-1)!, engine, false);
}

async function artifacts(home: string, engine: AccountEngine): Promise<string[]> {
  const result: string[] = [];
  const inspect = async (directory: string, recursive = false) => {
    const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('账号备份检查目录必须是实际目录');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (isAccountArtifactPath(relative(home, file).split(sep).join('/'), engine)) {
        if (!entry.isFile()) throw new Error('账号临时文件或备份类型无效，已保留原文件');
        result.push(file);
      } else if (recursive && entry.isDirectory()) await inspect(file, true);
    }
  };
  await inspect(home);
  const engineHome = join(home, engine === 'claude' ? '.claude' : '.codex');
  await inspect(engineHome);
  await inspect(join(engineHome, 'backups'), true);
  return result;
}

export async function archiveAccountArtifacts(dataDir: string, slotId: string, home: string, engine: AccountEngine): Promise<void> {
  const files = await artifacts(home, engine);
  if (!files.length) return;
  const archive = join(dataDir, 'backups', 'slot-account-artifacts', accountIdentifier(slotId), randomUUID());
  await privateDirectory(archive);
  for (const file of files) {
    const target = join(archive, relative(home, file));
    await privateDirectory(dirname(target));
    await rename(file, target);
  }
}

export async function assertNoAccountArtifacts(home: string, engine: AccountEngine): Promise<void> {
  if ((await artifacts(home, engine)).length) {
    throw new Error('用户槽位配置中发现账号临时文件或备份，已保留原文件，请管理员归档检查后恢复');
  }
}
