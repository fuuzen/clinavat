import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEngine } from '../../agent/engines.js';
import { metadata } from './files.js';
import { userSessionStateRoot } from './layout.js';

const nativeIdPattern = /^[0-9A-Za-z][0-9A-Za-z-]{7,127}$/;

async function anyEntry(directory: string, matches: (name: string) => boolean, recursive: boolean): Promise<boolean> {
  const entries = await readdir(directory, { recursive }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  return entries.some(entry => matches(entry.split('/').pop() ?? entry));
}

async function claudeTranscriptExists(root: string, nativeId: string): Promise<boolean> {
  const projects = join(root, 'projects');
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    if (await metadata(join(projects, project, `${nativeId}.jsonl`))) return true;
  }
  return false;
}

async function codexRolloutExists(root: string, nativeId: string): Promise<boolean> {
  const matches = (name: string) => name.endsWith(`${nativeId}.jsonl`);
  return await anyEntry(join(root, 'sessions'), matches, true) || await anyEntry(join(root, 'archived_sessions'), matches, true);
}

/**
 * Whether the engine's own store still holds a native conversation, checked before resuming it. Only a store that
 * exists and lacks the conversation counts as lost; anything unexpected is left for the CLI to report.
 */
export async function nativeSessionLost(
  dataDir: string, userId: string, engine: AgentEngine, nativeId: string, transcript?: string | null,
): Promise<boolean> {
  if (!nativeIdPattern.test(nativeId)) return false;
  const root = userSessionStateRoot(dataDir, userId, engine);
  try {
    if (!(await metadata(root))?.isDirectory()) return false;
    if (transcript && await metadata(transcript)) return false;
    if (engine === 'antigravity') return !await metadata(join(root, 'conversations', `${nativeId}.db`));
    if (engine === 'claude') return !await claudeTranscriptExists(root, nativeId);
    return !await codexRolloutExists(root, nativeId);
  } catch {
    return false;
  }
}
