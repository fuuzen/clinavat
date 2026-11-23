import { z } from 'zod';
import type { Store } from '../database.js';
import { HttpError, type Project } from '../models.js';

export const memoryKeySchema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9_-]{0,47}$/,
  'key: lowercase letters, digits, "-" and "_", at most 48 characters (e.g. "architecture", "decisions")',
);

const maxEntriesPerProject = 24;

export interface MemoryRow {
  project_id: string;
  key: string;
  content: string;
  updated_at: string;
}

export interface MemoryView {
  key: string;
  content: string;
  updatedAt: string;
}

/** Durable project-level notes maintained by master / Super Agent conversations across turns and rollovers. */
export class ProjectMemory {
  constructor(private readonly store: Store) {}

  rootProjectId(projectId: string): string {
    const project = this.store.get<Pick<Project, 'id' | 'parent_project_id'>>(
      'SELECT id,parent_project_id FROM projects WHERE id=?', projectId,
    );
    if (!project) throw new HttpError(404, '项目不存在');
    return project.parent_project_id ?? project.id;
  }

  view(projectId: string): MemoryView[] {
    const rootId = this.rootProjectId(projectId);
    return this.store.all<MemoryRow>(
      'SELECT * FROM project_memories WHERE project_id=? ORDER BY key', rootId,
    ).map(row => ({ key: row.key, content: row.content, updatedAt: row.updated_at }));
  }

  read(projectId: string, key: string): MemoryView {
    const rootId = this.rootProjectId(projectId);
    const normalized = memoryKeySchema.parse(key);
    const row = this.store.get<MemoryRow>(
      'SELECT * FROM project_memories WHERE project_id=? AND key=?', rootId, normalized,
    );
    if (!row) throw new HttpError(404, `持久记忆中没有条目 ${normalized}，请先用 memory(action="list") 查看`);
    return { key: row.key, content: row.content, updatedAt: row.updated_at };
  }

  write(projectId: string, key: string, content: string): MemoryView {
    const rootId = this.rootProjectId(projectId);
    const normalized = memoryKeySchema.parse(key);
    const body = content.trim();
    if (!body) throw new HttpError(400, '记忆内容不能为空');
    const existing = this.store.get<{ key: string }>(
      'SELECT key FROM project_memories WHERE project_id=? AND key=?', rootId, normalized,
    );
    if (!existing) {
      const count = this.store.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM project_memories WHERE project_id=?', rootId,
      )?.count ?? 0;
      if (count >= maxEntriesPerProject) {
        throw new HttpError(409, `本项目持久记忆已达上限 ${maxEntriesPerProject} 条，请合并或删除旧条目后再写入`);
      }
    }
    this.store.run(
      `INSERT INTO project_memories(project_id,key,content,updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(project_id,key) DO UPDATE SET content=excluded.content,updated_at=datetime('now')`,
      rootId, normalized, body,
    );
    return this.read(rootId, normalized);
  }

  remove(projectId: string, key: string): boolean {
    const rootId = this.rootProjectId(projectId);
    const normalized = memoryKeySchema.parse(key);
    const result = this.store.run('DELETE FROM project_memories WHERE project_id=? AND key=?', rootId, normalized);
    return Number(result.changes) > 0;
  }

  briefingLines(projectId: string): string[] {
    let entries: MemoryView[];
    try { entries = this.view(projectId); }
    catch { return []; }
    if (!entries.length) return [];
    let budget = 2000;
    const lines = [`- Persistent Project Memory (${entries.length} entries):`];
    for (const entry of entries) {
      const singleLine = entry.content.replace(/\s+/g, ' ').trim();
      const maxSlice = Math.max(120, Math.min(320, budget));
      if (singleLine.length <= maxSlice && budget >= singleLine.length) {
        lines.push(`  - \`${entry.key}\`: ${singleLine}`);
        budget -= singleLine.length;
      } else {
        const preview = singleLine.slice(0, 140);
        lines.push(`  - \`${entry.key}\`: ${preview}… (call memory(action="read", key="${entry.key}") for full note)`);
        budget = Math.max(0, budget - 160);
      }
    }
    return lines;
  }
}
