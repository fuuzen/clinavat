import { randomUUID } from 'node:crypto';
import type { Store } from '../database.js';
import { HttpError, type Session } from '../models.js';
import { orchestrationConstants } from './limits.js';
import { orchestrationModeOf } from '../agent/orchestration-tools.js';
import type { Context } from '../context.js';

export const workItemStatuses = ['pending', 'in_progress', 'verifying', 'blocked', 'completed', 'cancelled'] as const;
export type WorkItemStatus = typeof workItemStatuses[number];

export interface WorkItemRow {
  id: string;
  master_session_id: string;
  seq: number;
  title: string;
  description: string | null;
  acceptance: string | null;
  status: WorkItemStatus;
  assigned_agent: string | null;
  depends_on: string | null;
  summary: string | null;
  review_rounds: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemView {
  id: string;
  code: string;
  title: string;
  description: string | null;
  acceptance: string | null;
  status: WorkItemStatus;
  assignedAgent: string | null;
  dependsOn: string[];
  summary: string | null;
  reviewRounds: number;
  updatedAt: string;
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
    return this.store.all<WorkItemRow>('SELECT * FROM work_items WHERE master_session_id=? ORDER BY seq', masterId);
  }

  view(masterId: string): WorkItemView[] {
    return this.rows(masterId).map(row => this.serialize(row));
  }

  add(masterId: string, items: NewWorkItem[]): WorkItemView[] {
    const created: WorkItemRow[] = [];
    this.store.transaction(() => {
      let nextSeq = (this.store.get<{ max: number | null }>(
        'SELECT MAX(seq) AS max FROM work_items WHERE master_session_id=?', masterId)?.max ?? 0) + 1;
      for (const item of items) {
        const id = randomUUID();
        const seq = nextSeq++;
        const depends = item.dependsOn?.length
          ? JSON.stringify(item.dependsOn.map(dep => {
              const num = normalizeCode(dep);
              return num !== undefined ? codeOf(num) : dep.trim();
            }))
          : null;
        const status: WorkItemStatus = item.assignedAgent ? 'in_progress' : 'pending';
        this.store.run(
          `INSERT INTO work_items(id,master_session_id,seq,title,description,acceptance,status,assigned_agent,depends_on)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          id, masterId, seq, item.title.trim(), item.description?.trim() || null,
          item.acceptance?.trim() || null, status, item.assignedAgent?.trim() || null, depends,
        );
        created.push(this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', id)!);
      }
    });
    return created.map(row => this.serialize(row));
  }

  update(masterId: string, patches: WorkItemPatch[]): WorkItemView[] {
    const updated: WorkItemRow[] = [];
    this.store.transaction(() => {
      for (const patch of patches) {
        const current = this.find(masterId, patch.task);
        if (!current) throw new HttpError(404, `任务看板中没有任务 ${patch.task}，请先用 task_board(action="list") 查看`);
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

  /** Links a task to a newly started child agent and moves pending tasks to in_progress. */
  assign(masterId: string, reference: string, agentName: string): WorkItemView {
    const current = this.find(masterId, reference);
    if (!current) throw new HttpError(404, `任务看板中没有任务 ${reference}`);
    const nextStatus: WorkItemStatus = current.status === 'pending' ? 'in_progress' : current.status;
    this.store.run(
      `UPDATE work_items SET assigned_agent=?,status=?,updated_at=datetime('now') WHERE id=?`,
      agentName, nextStatus, current.id,
    );
    return this.serialize(this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', current.id)!);
  }

  resolve(masterId: string, reference: string): WorkItemRow {
    const item = this.find(masterId, reference);
    if (!item) throw new HttpError(404, `任务看板中没有任务 ${reference}`);
    return item;
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
      WHERE master_session_id=? AND review_rounds>0 AND status NOT IN ('completed','cancelled')`, masterId).changes > 0;
  }

  private latestUserMessage(masterId: string): number | undefined {
    return this.store.get<{ rowid: number }>(
      "SELECT rowid FROM messages WHERE session_id=? AND role='user' AND source IS NULL ORDER BY rowid DESC LIMIT 1", masterId)?.rowid;
  }

  briefingLines(masterId: string): string[] {
    const items = this.view(masterId);
    if (!items.length) return [];
    const done = items.filter(item => item.status === 'completed').length;
    const active = items.filter(item => !['completed', 'cancelled'].includes(item.status));
    const shown = [...active, ...items.filter(item => item.status === 'completed').slice(-5)].slice(0, 12);
    return [
      `- Task Board (${done}/${items.length} completed):`,
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
      const bySeq = this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE master_session_id=? AND seq=?', masterId, seq);
      if (bySeq) return bySeq;
    }
    return this.store.get<WorkItemRow>('SELECT * FROM work_items WHERE master_session_id=? AND id=?', masterId, reference.trim());
  }

  private serialize(row: WorkItemRow): WorkItemView {
    return {
      id: row.id,
      code: codeOf(row.seq),
      title: row.title,
      description: row.description,
      acceptance: row.acceptance,
      status: row.status,
      assignedAgent: row.assigned_agent,
      dependsOn: row.depends_on ? JSON.parse(row.depends_on) as string[] : [],
      summary: row.summary,
      reviewRounds: row.review_rounds,
      updatedAt: row.updated_at,
    };
  }
}
