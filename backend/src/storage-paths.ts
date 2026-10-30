import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function brandedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('CC_POOL_')) environment[name.replace(/^CC_POOL_/, 'CLINAVAT_')] ??= value;
  }
  return environment;
}

export function defaultWorkspaceDirectory(): string {
  // Existing project and native-session paths must keep resolving after an upgrade.
  const legacyDirectory = '/var/tmp/cc-pool-workspace';
  return existsSync(legacyDirectory) ? legacyDirectory : '/var/tmp/clinavat-workspace';
}

export function databasePath(dataDirectory: string): string {
  const currentPath = join(resolve(dataDirectory), 'clinavat.sqlite');
  const legacyPath = join(resolve(dataDirectory), 'cc-pool.sqlite');
  if (!existsSync(currentPath)) return existsSync(legacyPath) ? legacyPath : currentPath;
  if (existsSync(legacyPath)) {
    if (realpathSync(currentPath) !== realpathSync(legacyPath)) {
      throw new Error('数据目录同时存在 clinavat.sqlite 和 cc-pool.sqlite，请先确认并保留正确的数据库，避免使用错误的数据');
    }
  }
  return realpathSync(currentPath);
}
