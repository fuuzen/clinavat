import { constants } from 'node:fs';
import { access, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from '../models.js';

export async function localProjectPath(path: string | undefined, source: 'existing' | 'new'): Promise<string> {
  if (!path) throw new HttpError(400, '请选择本机项目的绝对路径');
  try {
    if (source === 'new') await mkdir(path, { mode: 0o700 });
    const canonicalPath = await realpath(path);
    if (!(await stat(canonicalPath)).isDirectory()) throw new HttpError(400, '本机项目路径必须是目录');
    await access(canonicalPath, constants.R_OK | constants.W_OK | constants.X_OK);
    return canonicalPath;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new HttpError(409, '本机目录已存在，请选择“打开已有目录”');
    if (code === 'ENOENT') throw new HttpError(400, source === 'new' ? '父目录不存在，请先选择已有父目录' : '本机目录不存在');
    throw new HttpError(400, `无法访问本机项目目录：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function localDirectories(path: string) {
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) throw new HttpError(400, '请输入本机绝对路径');
  try {
    const canonicalPath = await realpath(path);
    const entries = await readdir(canonicalPath, { withFileTypes: true });
    const directories = await Promise.all(entries.map(async entry => {
      const fullPath = join(canonicalPath, entry.name);
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(fullPath).then(info => info.isDirectory()).catch(() => false));
      return directory ? { name: entry.name, path: fullPath, type: 'directory' as const } : null;
    }));
    return { path: canonicalPath, entries: directories.filter(entry => entry !== null).sort((left, right) => left.name.localeCompare(right.name)) };
  } catch (error) {
    throw new HttpError(400, `无法读取本机目录：${error instanceof Error ? error.message : String(error)}`);
  }
}
