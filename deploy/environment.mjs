import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnvironment(environmentFile) {
  process.loadEnvFile(environmentFile);
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('CC_POOL_')) process.env[name.replace(/^CC_POOL_/, 'CLINAVAT_')] ??= value;
  }
}

export function databasePath(dataDirectory) {
  const current = join(dataDirectory, 'clinavat.sqlite');
  const legacy = join(dataDirectory, 'cc-pool.sqlite');
  if (existsSync(current) && existsSync(legacy) && realpathSync(current) !== realpathSync(legacy)) {
    throw new Error('新旧数据库同时存在，无法确定当前数据；请先完成离线迁移');
  }
  const path = existsSync(current) ? current : legacy;
  if (!existsSync(path)) throw new Error(`找不到已有数据库：${current}`);
  return path;
}
