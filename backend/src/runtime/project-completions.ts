import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { HttpError, type Project } from '../models.js';
import type { WorkspaceManager } from './workspace.js';

const hiddenDirectories = new Set([
  '.git', '.bin', '.claude', '.codex', '.ssh', '.aws', '.gnupg',
  '.netrc', '.npmrc', '.pypirc',
  'node_modules', 'vendor', 'dist', 'build', 'target', '.next', '.nuxt',
  '.cache', '.venv', 'venv', '__pycache__', 'coverage',
]);
const environmentExamples = new Set(['.env.example', '.env.sample', '.env.template']);

export function allowedReferencePath(path: string): boolean {
  if (!path || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)) return false;
  return path.split('/').every(part => part !== '..' && !hiddenDirectories.has(part)
    && (!(part === '.env' || part.startsWith('.env.')) || environmentExamples.has(part))
    && !/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|auth\.json)$/i.test(part)
    && !/\.(?:pem|key|p12|pfx)$/i.test(part));
}

export function visibleProjectPath(workspaces: WorkspaceManager, project: Project, path: string): boolean {
  if (!allowedReferencePath(path)) return false;
  const target = resolve(project.local_path, path);
  const inside = (root: string, candidate: string) => {
    const child = relative(resolve(root), candidate);
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  };
  if (inside(workspaces.config.dataDir, target)) return false;
  return !inside(workspaces.config.workspaceDir, target) || inside(workspaces.config.workspaceDir, resolve(project.local_path));
}

export async function assertReadableReference(workspaces: WorkspaceManager, project: Project, path: string): Promise<void> {
  if (!visibleProjectPath(workspaces, project, path || '.')) throw new HttpError(400, '无法引用运行配置或私密文件');
  const root = await realpath(project.local_path);
  const requested = resolve(root, path);
  const actual = await realpath(requested);
  if (actual !== requested) throw new HttpError(400, '文件引用不支持符号链接路径');
  if (!visibleProjectPath(workspaces, project, relative(root, actual) || '.')) throw new HttpError(400, '无法引用运行配置或私密文件');
}

export interface PathCompletion { path: string; type: 'file' | 'directory' }

export async function completeProjectPaths(workspaces: WorkspaceManager, project: Project, query: string) {
  if (query.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(query) || query.split('/').includes('..')) {
    throw new HttpError(400, '请输入项目内的相对路径');
  }
  const slash = query.lastIndexOf('/');
  const directory = slash >= 0 ? query.slice(0, slash) : '';
  const needle = query.slice(slash + 1).toLocaleLowerCase();
  const queue = [directory];
  const matches: PathCompletion[] = [];
  let inspected = 0;
  let truncated = false;
  const deadline = Date.now() + 400;
  while (queue.length) {
    const current = queue.shift()!;
    if (current && !visibleProjectPath(workspaces, project, current)) continue;
    let entries;
    try {
      await assertReadableReference(workspaces, project, current);
      entries = (await workspaces.files(project, current)).entries;
    }
    catch (error) {
      if (!current) throw error;
      continue;
    }
    for (const entry of entries) {
      if (++inspected > 12000 || Date.now() > deadline) { truncated = true; break; }
      if (!visibleProjectPath(workspaces, project, entry.path)) continue;
      if (!needle || entry.name.toLocaleLowerCase().includes(needle)) matches.push({ path: entry.path, type: entry.type });
      if (slash < 0 && needle && entry.type === 'directory' && current.split('/').length < 12) queue.push(entry.path);
    }
    if (truncated || matches.length >= 240) { truncated = true; break; }
  }
  matches.sort((left, right) => {
    const score = (entry: PathCompletion) => {
      const name = entry.path.split('/').at(-1)!.toLocaleLowerCase();
      return (name === needle ? 0 : name.startsWith(needle) ? 1 : 2) * 100
        + entry.path.split('/').length * 2 + (entry.type === 'directory' ? 0 : 1);
    };
    return score(left) - score(right) || left.path.localeCompare(right.path);
  });
  return { entries: matches.slice(0, 60), truncated: truncated || matches.length > 60 };
}
