import type { Store } from './database.js';
import type { EventBus } from './events.js';
import type { SkippedLink, SkippedLinks } from './runtime/sync-status.js';

const STORED_LIMIT = 50;
const LISTED_LIMIT = 5;

const linkKey = (link: SkippedLink) => `${link.side}\t${link.path}`;

function readStored(value: string | null): SkippedLinks {
  if (!value) return { links: [], more: 0 };
  try { return JSON.parse(value) as SkippedLinks; }
  catch { return { links: [], more: 0 }; }
}

/**
 * Records the symbolic links a project's sync currently skips, and tells the user about those that newly appear.
 * Returns the new ones, so the barrier of the command that created them can tell the agent too.
 */
export function recordSkippedLinks(store: Store, events: EventBus, userId: string, syncName: string, skipped: SkippedLinks): SkippedLink[] {
  const project = store.get<{ id: string; name: string; sync_skipped_links: string | null }>(
    "SELECT id,name,sync_skipped_links FROM projects WHERE user_id=? AND sync_name=? AND execution_mode IS NOT 'local'", userId, syncName);
  if (!project) return [];
  const known = new Set(readStored(project.sync_skipped_links).links.map(linkKey));
  const fresh = skipped.links.filter(link => !known.has(linkKey(link)));
  const stored: SkippedLinks = {
    links: skipped.links.slice(0, STORED_LIMIT),
    more: skipped.more + Math.max(0, skipped.links.length - STORED_LIMIT),
  };
  const serialized = stored.links.length || stored.more ? JSON.stringify(stored) : null;
  if (serialized === project.sync_skipped_links) return fresh;
  store.run('UPDATE projects SET sync_skipped_links=? WHERE id=?', serialized, project.id);
  events.emit(userId, { type: 'project', payload: { id: project.id, sync_skipped_links: serialized } });
  if (fresh.length) {
    const listed = fresh.slice(0, LISTED_LIMIT).map(link => link.path).join('、');
    const rest = fresh.length > LISTED_LIMIT ? ` 等 ${fresh.length} 个` : '';
    events.emit(userId, { type: 'notice', payload: { kind: 'warning', message:
      `项目「${project.name}」有软链接无法同步，已跳过：${listed}${rest}。目标为绝对路径或指向项目外的软链接只存在于一端；`
      + '可在工作区底部查看，改为项目内的相对路径软链接，或把它们所在的编译目录加入排除规则。' } });
  }
  return fresh;
}

/** One line for the agent, printed by the command that left these links unsynced. */
export function describeSkippedLinks(links: SkippedLink[]): string | undefined {
  if (!links.length) return undefined;
  const listed = links.slice(0, LISTED_LIMIT)
    .map(link => `${link.path} (${link.side === 'alpha' ? 'on the dev machine' : 'in the local mirror'}: ${link.reason})`).join('; ');
  const rest = links.length > LISTED_LIMIT ? `; and ${links.length - LISTED_LIMIT} more` : '';
  return `remote-shell: ${links.length} symbolic link(s) cannot be synced and are missing on the other side: ${listed}${rest}. `
    + 'Only relative links that stay inside the project are synced; recreate them with `ln -sfr`, '
    + "or ask the user to add their build directory to the project's sync ignore rules.";
}
