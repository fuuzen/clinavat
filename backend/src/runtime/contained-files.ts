import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, readlink, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ContainedFile {
  handle: FileHandle;
  /** The opened object's real path, read back from the descriptor. */
  actualPath: string;
  size: number;
  mtime: number;
}

/**
 * Opens a path inside a tree that an execution environment can modify at any moment. The descriptor pins
 * the object, so checking what it refers to cannot race with a swapped symlink the way lstat-then-read can.
 * Non-blocking open keeps a planted FIFO from hanging the Hub.
 */
export async function openContained(root: string, path: string, options: { directory?: boolean; followLinks?: boolean } = {}): Promise<ContainedFile> {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, path);
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK
    | (options.directory ? constants.O_DIRECTORY : 0) | (options.followLinks ? 0 : constants.O_NOFOLLOW));
  try {
    const actualPath = await readlink(`/proc/self/fd/${handle.fd}`);
    const child = relative(realRoot, actualPath);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('路径超出允许的目录范围');
    if (!options.followLinks && actualPath !== target) throw new Error('路径中不能包含符号链接');
    const metadata = await handle.stat();
    if (options.directory ? !metadata.isDirectory() : !metadata.isFile()) throw new Error('路径类型无效');
    return { handle, actualPath, size: metadata.size, mtime: Math.floor(metadata.mtimeMs) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Directory entries of an open directory; going through the descriptor keeps the path from being swapped. */
export function descriptorPath(handle: FileHandle): string {
  return join('/proc/self/fd', String(handle.fd));
}

/**
 * Opens a directory below root one component at a time, creating missing ones when asked. Each component is made
 * through its parent's descriptor and reopened with the symlink check, so a link planted mid-way is rejected, never followed.
 */
export async function openContainedDirectory(root: string, segments: string[], create: boolean): Promise<ContainedFile> {
  let directory = await openContained(root, '.', { directory: true });
  for (let depth = 1; depth <= segments.length; depth++) {
    try {
      if (create) {
        await mkdir(join(descriptorPath(directory.handle), segments[depth - 1]!)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
    } finally { await directory.handle.close(); }
    directory = await openContained(root, segments.slice(0, depth).join('/'), { directory: true });
  }
  return directory;
}

/**
 * Moves a finished file into an open directory. Without `replace`, link() refuses an existing entry instead of
 * overwriting it. A source on another filesystem is copied next to the target first, so the target never appears half-written.
 */
export async function placeFile(directory: FileHandle, name: string, source: string, replace: boolean): Promise<void> {
  const target = join(descriptorPath(directory), name);
  const move = (from: string) => replace ? rename(from, target) : link(from, target);
  try { return await move(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  const nearby = join(descriptorPath(directory), `.clinavat-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await copyFile(source, nearby, constants.COPYFILE_EXCL);
    await move(nearby);
  } finally { await rm(nearby, { force: true }); }
}
