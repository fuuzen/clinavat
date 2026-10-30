import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function metadata(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

export async function directoryEntries(directory: string): Promise<string[]> {
  const entry = await metadata(directory);
  if (!entry) return [];
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('原生会话数据目录必须是实际目录');
  return readdir(directory);
}

export async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await directoryEntries(directory)) {
    const file = join(directory, name);
    const entry = await lstat(file);
    if (entry.isDirectory()) files.push(...await regularFiles(file));
    else if (entry.isFile()) files.push(file);
    else throw new Error('原生会话迁移拒绝符号链接或特殊文件，原目录已保留');
  }
  return files;
}

export async function copyState(source: string, target: string, replace = false): Promise<void> {
  const entry = await metadata(source);
  if (!entry) return;
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
    throw new Error('原生会话迁移拒绝符号链接或特殊文件，原目录已保留');
  }
  const existing = await metadata(target);
  if (existing?.isSymbolicLink() || (existing && existing.isDirectory() !== entry.isDirectory())) {
    throw new Error('原生会话迁移目标类型冲突，原目录已保留');
  }
  if (entry.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) await copyState(join(source, name), join(target, name), replace);
    return;
  }
  if (existing && !replace) {
    const [before, after] = await Promise.all([readFile(target), readFile(source)]);
    if (before.equals(after)) return;
    if (source.endsWith('.jsonl')) {
      if (before.length > after.length && before.subarray(0, after.length).equals(after)) return;
      if (!(after.length > before.length && after.subarray(0, before.length).equals(before))) {
        throw new Error('原生会话历史存在不同分支，已保留原目录并停止迁移');
      }
    } else {
      const fingerprint = createHash('sha256').update(source).digest('hex').slice(0, 12);
      throw new Error(`原生会话附属状态冲突（${fingerprint}），已保留原目录并停止迁移`);
    }
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
}
