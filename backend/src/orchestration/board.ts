import { randomUUID } from 'node:crypto';
import type { Store } from '../database.js';
import { HttpError, type Session } from '../models.js';
import { orchestrationConstants } from './limits.js';
import { orchestrationModeOf } from '../agent/orchestration-tools.js';
import type { Context } from '../context.js';

export const workItemStatuses = ['pending', 'in_progress', 'verifying', 'blocked', 'completed', 'cancelled'] as const;
export type WorkItemStatus = typeof workItemStatuses[number];
const archivableStatuses = new Set<WorkItemStatus>(['completed', 'cancelled']);

export interface WorkItemRow {
  id: string;
  master_session_id: string;
  stage: number;
  seq: number;
  title: string;
  description: string | null;
  acceptance: string | null;
  status: WorkItemStatus;
  assigned_agent: string | null;
  depends_on: string | null;
  summary: string | null;
  review_rounds: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemView {
  id: string;
  code: string;
  stage: number;
  title: string;
  description: string | null;
  acceptance: string | null;
  status: WorkItemStatus;
  assignedAgent: string | null;
  dependsOn: string[];
  summary: string | null;
  reviewRounds: number;
  archivedAt: string | null;
  updatedAt: string;
}

export interface WorkBoardListView {
  tasks: WorkItemView[];
  archivedCount: number;
  currentStage: number;
  archivedTasks?: WorkItemView[];
}

export interface WorkBoardArchiveResult {
  archived: WorkItemView[];
  tasks: WorkItemView[];
  archivedCount: number;
  currentStage: number;
}

export interface NewWorkItem {
  title: string;
  description?: string;
  acceptance?: string;
  assignedAgent?: string;
  dependsOn?: string[];
}

export interface WorkItemPatch {
  task: string;
  title?: string;
  status?: WorkItemStatus;
  assignedAgent?: string | null;
  acceptance?: string | null;
  summary?: string | null;
}

export interface TaskBoardToolInput {
  action: 'list' | 'add' | 'update' | 'archive';
  tasks?: NewWorkItem[];
  updates?: WorkItemPatch[];
  codes?: string[];
  includeArchived?: boolean;
}

const codeOf = (seq: number) => `T${seq}`;

const normalizeCode = (reference: string): number | undefined => {
  const match = /^T?(\d+)$/i.exec(reference.trim());
  return match ? Number(match[1]) : undefined;
};

/** Called when a user-authored message is saved, so queued inputs take effect when they reach the master. */
export function resetReviewsForUserMessage(context: Context, session: Session): void {
  if (orchestrationModeOf(session) === 'super' && new WorkBoard(context.store).resetReviews(session.id)) {
    context.config.orchestration?.publish?.(session.id);
  }
}

/** Persistent task board for a master/Super Agent conversation. */
export class WorkBoard {
  constructor(private readonly store: Store) {}

  rows(masterId: string): WorkItemRow[] {
    return this.store.all<WorkItemRow>(
      'SELECT * FROM work_items WHERE master_session_id=? AND archived_at IS NULL ORDER BY seq ASC',
      masterId,
    );
  }

  archivedRows(masterId: string): WorkItemRow[] {
    return this.store.all<WorkItemRow>(
      'SELECT * FROM work_items WHERE master_session_id=? AND archived_at IS NOT NULL ORDER BY stage DESC, seq ASC',
      masterId,
    );
  }

  archivedCount(masterId: string): number {
    return this.store.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM work_items WHERE master_session_id=? AND archived_at IS NOT NULL',
      masterId,
    )?.count ?? 0;
  }

  currentStage(masterId: string): number {
    const active = this.store.get<{ max: number | null }>(
      'SELECT MAX(stage) AS max FROM work_items WHERE master_session_id=? AND archived_at IS NULL',
      masterId,
    )?.max;
    if (active !== null && active !== undefined) return active;
    const maxArchived = this.store.get<{ max: number }>(
      'SELECT COALESCE(MAX(stage), 0) AS max FROM work_items WHERE master_session_id=?',
      masterId,
    )?.max ?? 0;
    return maxArchived + 1;
  }

  view(masterId: string): WorkItemView[] {
    return this.rows(masterId).map(row => this.serialize(row));
  }

  list(masterId: string, options?: { includeArchived?: boolean }): WorkBoardListView {
    const tasks = this.view(masterId);
    const archivedCount = this.archivedCount(masterId);
    const currentStage = this.currentStage(masterId);
    if (!options?.includeArchived) return { tasks, archivedCount, currentStage };
    const archivedTasks = this.archivedRows(masterId).map(row => this.serialize(row));
    return { tasks, archivedCount, currentStage, archivedTasks };
  }

  add(masterId: string, items: NewWorkItem[]): WorkItemView[] {
    const created: WorkItemRow[] = [];
    this.store.transaction(() => {
      const activeRows = this.rows(masterId);
      let stage: number;
      let nextSeq: number;
      if (activeRows.length > 0) {
        stage = Math.max(...activeRows.map(row => row.stage));
        nextSeq = (this.store.get<{ max: number | null }>(
          'SELECT MAX(seq) AS max FROM work_items WHERE master_session_id=? AND stage=?',
          masterId, stage,
        )?.max ?? 0) + 1;
      } else {
        const maxArchivedStage = this.store.get<{ max: number }>(
          'SELECT COALESCE(MAX(stage), 0) AS max FROM work_items WHERE master_session_id=?',
          masterId,
        )?.max ?? 0;
        stage = maxArchivedStage + 1;
        nextSeq = 1;
      }

      // Dependencies resolve against active tasks, same-stage archived completed tasks, or peers in this add batch.
      const allowedBySeq = new Map<number, string>();
      const allowedById = new Map<string, string>();
      for (const row of activeRows) {
        allowedBySeq.set(row.seq, codeOf(row.seq));
        allowedById.set(row.id, codeOf(row.seq));
      }
      const sameStageCompleted = this.store.all<Pick<WorkItemRow, 'id' | 'seq'>>(
        "SELECT id,seq FROM work_items WHERE master_session_id=? AND stage=? AND archived_at IS NOT NULL AND status='completed'",
        masterId, stage,
      );
      for (const row of sameStageCompleted) {
        if (!allowedBySeq.has(row.seq)) allowedBySeq.set(row.seq, codeOf(row.seq));
        allowedById.set(row.id, codeOf(row.seq));
      }

      const planned = items.map((item, index) => ({ item, id: randomUUID(), seq: nextSeq + index }));
      const batchSeqs = new Set(planned.map(entry => entry.seq));

      for (const entry of planned) {
        const resolvedDeps: string[] = [];
        const seenDeps = new Set<string>();
        for (const rawDep of entry.item.dependsOn ?? []) {
          const trimmed = rawDep.trim();
          const num = normalizeCode(trimmed);
          let canonical: string | undefined;
          if (num !== undefined) {
            if (num === entry.seq) {
              throw new HttpError(400, `任务 ${codeOf(entry.seq)} 不能依赖自身`);
            }
            if (allowedBySeq.has(num) || batchSeqs.has(num)) canonical = codeOf(num);
          } else {
            canonical = allowedById.get(trimmed);
          }
          if (!canonical) {
            throw new HttpError(400, `任务 ${codeOf(entry.seq)} 的前置依赖 ${trimmed} 不存在或不可引用（仅支持当前活跃任务或同阶段已归档的已完成任务）`);
          }
          if (!seenDeps.has(canonical)) {
            seenDeps.add(canonical);
            resolvedDeps.push(canonical);
          }
        }
        const depends = resolvedDeps.length ? JSON.stringify(resolvedDeps) : null;
        const status: WorkItemStatus = entry.item.assignedAgent ? 'in_progress' : 'pending';
        this.store.run(
          `INSERT INTO work_items(id,master_session_id,stage,seq,title,description,acceptance,status,assigned_agent,depends_on)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          entry.id, masterId, stage, entry.seq, entry.item.title.trim(), entry.item.description?.trim() || null,
          entry.item.acceptance?.trim() || null, status, entry.item.assignedAgent?.trim() || null, depends,
        );
        created.push(this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', entry.id)!);
      }
    });
    return created.map(row => this.serialize(row));
  }

  update(masterId: string, patches: WorkItemPatch[]): WorkItemView[] {
    const updated: WorkItemRow[] = [];
    this.store.transaction(() => {
      for (const patch of patches) {
        const current = this.find(masterId, patch.task);
        if (!current) throw new HttpError(404, `任务看板中没有活跃任务 ${patch.task}，请先用 task_board(action="list") 查看`);
        const title = patch.title !== undefined ? patch.title.trim() : current.title;
        const status = patch.status ?? current.status;
        const assigned = patch.assignedAgent === undefined ? current.assigned_agent : (patch.assignedAgent?.trim() || null);
        const acceptance = patch.acceptance === undefined ? current.acceptance : (patch.acceptance?.trim() || null);
        const summary = patch.summary === undefined ? current.summary : (patch.summary?.trim() || null);
        this.store.run(
          `UPDATE work_items SET title=?,status=?,assigned_agent=?,acceptance=?,summary=?,updated_at=datetime('now') WHERE id=?`,
          title, status, assigned, acceptance, summary, current.id,
        );
        updated.push(this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', current.id)!);
      }
    });
    return updated.map(row => this.serialize(row));
  }

  archive(masterId: string, codesOrIds?: string[]): WorkBoardArchiveResult {
    const archivedRows: WorkItemRow[] = [];
    this.store.transaction(() => {
      let targets: WorkItemRow[];
      if (!codesOrIds || codesOrIds.length === 0) {
        targets = this.store.all<WorkItemRow>(
          `SELECT * FROM work_items WHERE master_session_id=? AND archived_at IS NULL
           AND status IN ('completed','cancelled') ORDER BY seq ASC`,
          masterId,
        );
      } else {
        targets = [];
        const seenIds = new Set<string>();
        for (const reference of codesOrIds) {
          const item = this.find(masterId, reference);
          if (!item) {
            throw new HttpError(400, `当前活跃任务看板中未找到任务 ${reference}`);
          }
          if (!archivableStatuses.has(item.status)) {
            throw new HttpError(400, `任务 ${codeOf(item.seq)} 当前状态为 ${item.status}，仅已完成（completed）或已取消（cancelled）的任务可归档`);
          }
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            targets.push(item);
          }
        }
      }
      for (const target of targets) {
        this.store.run(
          "UPDATE work_items SET archived_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND archived_at IS NULL",
          target.id,
        );
        const refreshed = this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', target.id);
        if (refreshed) archivedRows.push(refreshed);
      }
    });
    const listView = this.list(masterId);
    return {
      archived: archivedRows.map(row => this.serialize(row)),
      tasks: listView.tasks,
      archivedCount: listView.archivedCount,
      currentStage: listView.currentStage,
    };
  }

  execute(masterId: string, input: TaskBoardToolInput): { result: unknown; changed: boolean } {
    if (input.action === 'list') {
      return { result: this.list(masterId, { includeArchived: input.includeArchived }), changed: false };
    }
    if (input.action === 'add') {
      if (!input.tasks?.length) throw new HttpError(400, 'task_board(action="add") 需要提供 tasks 列表');
      const created = this.add(masterId, input.tasks);
      return { result: { created, ...this.list(masterId) }, changed: true };
    }
    if (input.action === 'archive') {
      const outcome = this.archive(masterId, input.codes);
      return { result: outcome, changed: outcome.archived.length > 0 };
    }
    if (!input.updates?.length) throw new HttpError(400, 'task_board(action="update") 需要提供 updates 列表');
    const updated = this.update(masterId, input.updates);
    return { result: { updated, ...this.list(masterId) }, changed: true };
  }

  /** Links a task to a newly started child agent and moves pending tasks to in_progress. */
  assign(masterId: string, reference: string, agentName: string): WorkItemView {
    const current = this.find(masterId, reference);
    if (!current) throw new HttpError(404, `任务看板中没有活跃任务 ${reference}`);
    const nextStatus: WorkItemStatus = current.status === 'pending' ? 'in_progress' : current.status;
    this.store.run(
      `UPDATE work_items SET assigned_agent=?,status=?,updated_at=datetime('now') WHERE id=?`,
      agentName, nextStatus, current.id,
    );
    return this.serialize(this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', current.id)!);
  }

  resolve(masterId: string, reference: string): WorkItemRow {
    const item = this.find(masterId, reference);
    if (!item) throw new HttpError(404, `任务看板中没有活跃任务 ${reference}`);
    return item;
  }

  resolveActive(masterId: string, reference: string | undefined): WorkItemRow | undefined {
    return reference ? this.find(masterId, reference) : undefined;
  }

  reviewTask(masterId: string, agentName: string | null): WorkItemRow | undefined {
    const tasks = this.rows(masterId).filter(item => agentName ? item.assigned_agent === agentName : item.status === 'verifying');
    if (tasks.length > 1) throw new HttpError(400, '有多个相关看板任务，请用 task 指定本次审查对应的任务。');
    return tasks[0];
  }

  beginReview(item: WorkItemRow): () => void {
    const maxRounds = orchestrationConstants.maxSuperReviewRounds;
    const userMessage = this.latestUserMessage(item.master_session_id);
    const updated = this.store.run(`UPDATE work_items SET review_rounds=review_rounds+1,updated_at=datetime('now')
      WHERE id=? AND review_rounds < ?`, item.id, maxRounds);
    if (!updated.changes) {
      throw new HttpError(409, `任务 ${codeOf(item.seq)} 已达到 ${maxRounds} 轮审查上限。请汇总分歧并向用户提出一个决策问题，或在仅剩非阻塞项时记录并接受。`);
    }
    // A failed dispatch may refund its round only while the same user message still defines the review budget.
    return () => {
      if (this.latestUserMessage(item.master_session_id) === userMessage) {
        this.store.run("UPDATE work_items SET review_rounds=MAX(0,review_rounds-1),updated_at=datetime('now') WHERE id=?", item.id);
      }
    };
  }

  resetReviews(masterId: string): boolean {
    return this.store.run(`UPDATE work_items SET review_rounds=0,updated_at=datetime('now')
      WHERE master_session_id=? AND archived_at IS NULL AND review_rounds>0 AND status NOT IN ('completed','cancelled')`, masterId).changes > 0;
  }

  private latestUserMessage(masterId: string): number | undefined {
    return this.store.get<{ rowid: number }>(
      "SELECT rowid FROM messages WHERE session_id=? AND role='user' AND source IS NULL ORDER BY rowid DESC LIMIT 1", masterId)?.rowid;
  }

  briefingLines(masterId: string): string[] {
    const items = this.view(masterId);
    const archived = this.archivedCount(masterId);
    if (!items.length && !archived) return [];
    if (!items.length) {
      return [`- Task Board (active 0, archived ${archived})`];
    }
    const done = items.filter(item => item.status === 'completed').length;
    const active = items.filter(item => !['completed', 'cancelled'].includes(item.status));
    const shown = [...active, ...items.filter(item => item.status === 'completed').slice(-5)].slice(0, 12);
    const header = archived > 0
      ? `- Task Board (active ${items.length}, archived ${archived}; ${done}/${items.length} completed):`
      : `- Task Board (${done}/${items.length} completed):`;
    return [
      header,
      ...shown.map(item => {
        const who = item.assignedAgent ? `, @${item.assignedAgent}` : '';
        const deps = item.dependsOn.length ? `, depends:${item.dependsOn.join('+')}` : '';
        const note = item.summary ? ` — ${item.summary.replace(/\s+/g, ' ').slice(0, 120)}` : '';
        const reviews = item.reviewRounds ? `, reviews:${item.reviewRounds}/${orchestrationConstants.maxSuperReviewRounds}` : '';
        return `  - \`${item.code}\` [${item.status}${who}${deps}${reviews}] ${item.title}${note}`;
      }),
    ];
  }

  private find(masterId: string, reference: string): WorkItemRow | undefined {
    const seq = normalizeCode(reference);
    if (seq !== undefined) {
      const bySeq = this.store.get<WorkItemRow>(
        'SELECT * FROM work_items WHERE master_session_id=? AND archived_at IS NULL AND seq=? ORDER BY stage DESC LIMIT 1',
        masterId, seq,
      );
      if (bySeq) return bySeq;
    }
    return this.store.get<WorkItemRow>(
      'SELECT * FROM work_items WHERE master_session_id=? AND archived_at IS NULL AND id=?',
      masterId, reference.trim(),
    );
  }

  private serialize(row: WorkItemRow): WorkItemView {
    return {
      id: row.id,
      code: codeOf(row.seq),
      stage: row.stage,
      title: row.title,
      description: row.description,
      acceptance: row.acceptance,
      status: row.status,
      assignedAgent: row.assigned_agent,
      dependsOn: row.depends_on ? JSON.parse(row.depends_on) as string[] : [],
      summary: row.summary,
      reviewRounds: row.review_rounds,
      archivedAt: row.archived_at,
      updatedAt: row.updated_at,
    };
  }
}
