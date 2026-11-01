import { lstat } from 'node:fs/promises';

export async function metadata(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}
