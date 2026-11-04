import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Everything the Hub keeps lives outside the source tree: a local project, including this repository, is mounted
// into slot machines, where agents can read it.
const home = (variable, fallback) => process.env[variable] || join(homedir(), fallback);

export function environmentFilePath() {
  return process.env.CLINAVAT_ENV_FILE || join(home('XDG_CONFIG_HOME', '.config'), 'clinavat', 'hub.env');
}

export function defaultDataDirectory() {
  return join(home('XDG_DATA_HOME', '.local/share'), 'clinavat');
}

export function releaseRoot() {
  return process.env.CLINAVAT_RELEASE_DIR || join(home('XDG_STATE_HOME', '.local/state'), 'clinavat', 'releases');
}

/** Where the deployed Hub and Web entry run from; agents cannot write here. */
export function installDirectory() {
  return process.env.CLINAVAT_INSTALL_DIR || join(homedir(), '.local/lib/clinavat');
}

export function loadEnvironment(environmentFile) {
  process.loadEnvFile(environmentFile);
}

/** The data directory from the loaded environment; relative values resolve as they do for the Hub. */
export function configuredDataDirectory(projectDirectory) {
  return resolve(projectDirectory, 'backend', process.env.CLINAVAT_DATA_DIR || defaultDataDirectory());
}

export function databasePath(dataDirectory) {
  return join(dataDirectory, 'clinavat.sqlite');
}
