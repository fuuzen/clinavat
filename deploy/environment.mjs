import { join } from 'node:path';

export function loadEnvironment(environmentFile) {
  process.loadEnvFile(environmentFile);
}

export function databasePath(dataDirectory) {
  return join(dataDirectory, 'clinavat.sqlite');
}
