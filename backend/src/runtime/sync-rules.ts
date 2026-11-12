import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SshManager } from './ssh.js';
import { IgnoreMatcher } from './sync-scan.js';
import { assertRemotePath, shellQuote, type DevHost } from './types.js';

export const SYNC_RULES_LIMIT = 64 * 1024;
// Before Clinavat kept the rules itself, projects stored them in this file at the remote project root.
const LEGACY_RULES_FILE = '.clinavatignore';
// Mutagen skips these with --ignore-vcs whatever the rules say, so a mirror copy is never synced content.
const VCS_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.bzr', '_darcs']);

export function assertSyncRules(rules: string): void {
  if (Buffer.byteLength(rules) > SYNC_RULES_LIMIT) throw new Error('排除规则超过 64 KiB');
  if (rules.includes('\0')) throw new Error('排除规则不能包含空字符');
}

/** The legacy rule file's content, or null when the project root has none. */
export async function readLegacyRules(ssh: SshManager, userId: string, host: DevHost, remotePath: string): Promise<string | null> {
  assertRemotePath(remotePath);
  const file = shellQuote(LEGACY_RULES_FILE);
  const result = await ssh.exec(userId, host, [
    `cd -- ${shellQuote(remotePath)} || exit`,
    `if [ -f ${file} ] && [ ! -L ${file} ]; then printf 'found\\0'; head -c ${SYNC_RULES_LIMIT + 1} -- ${file} || exit; fi`,
  ].join('\n'));
  if (result.code !== 0) throw new Error(`无法读取远端 ${LEGACY_RULES_FILE}：${result.stderr.trim() || `退出码 ${result.code}`}`);
  if (!result.stdout.startsWith('found\0')) return null;
  const rules = result.stdout.slice('found\0'.length);
  assertSyncRules(rules);
  return rules;
}

export async function removeLegacyRules(ssh: SshManager, userId: string, host: DevHost, remotePath: string): Promise<void> {
  assertRemotePath(remotePath);
  const file = shellQuote(LEGACY_RULES_FILE);
  const result = await ssh.exec(userId, host, [
    `cd -- ${shellQuote(remotePath)} || exit`,
    `if [ -f ${file} ] && [ ! -L ${file} ]; then rm -f -- ${file}; fi`,
  ].join('\n'));
  if (result.code !== 0) throw new Error(`无法删除远端 ${LEGACY_RULES_FILE}：${result.stderr.trim() || `退出码 ${result.code}`}`);
}

/**
 * Removes mirror entries whose ignore decision differs between two rule sets. A session created over the kept
 * mirror then neither keeps stale copies of newly ignored paths nor pushes local leftovers in newly included ones.
 */
export async function pruneChangedPaths(root: string, previous: string[], next: string[]): Promise<void> {
  const before = new IgnoreMatcher(previous);
  const after = new IgnoreMatcher(next);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (VCS_DIRECTORIES.has(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      const ignored = before.ignored(path, isDirectory);
      if (ignored !== after.ignored(path, isDirectory)) await rm(join(root, path), { recursive: true, force: true });
      else if (isDirectory && !ignored) await visit(path);
    }
  };
  await visit('');
}
