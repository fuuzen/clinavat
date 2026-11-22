import { randomUUID } from 'node:crypto';
import type { Store } from '../database.js';
import type { Session } from '../models.js';

export type TaskStatus = 'running' | 'completed' | 'interrupted' | 'error';

export interface AgentTask {
  id: string; master_session_id: string; child_session_id: string; prompt: string; status: TaskStatus;
  report: string | null; notify: 0 | 1; created_at: string; finished_at: string | null; delivered_at: string | null;
}

/** Each message a master sends a child is a task; it ends, with the child's reply as its report, when the child goes idle. */
export class AgentTasks {
  constructor(private readonly store: Store) {}

  create(masterId: string, childId: string, prompt: string, notify: boolean): AgentTask {
    const id = randomUUID();
    this.store.run('INSERT INTO agent_tasks(id,master_session_id,child_session_id,prompt,notify) VALUES(?,?,?,?,?)',
      id, masterId, childId, prompt, notify ? 1 : 0);
    return this.store.get<AgentTask>('SELECT * FROM agent_tasks WHERE id=?', id)!;
  }

  running(childId: string): AgentTask[] {
    return this.store.all<AgentTask>("SELECT * FROM agent_tasks WHERE child_session_id=? AND status='running' ORDER BY rowid", childId);
  }

  /** Ends every task the child was working on with the same outcome, and returns them. */
  finish(childId: string, status: Exclude<TaskStatus, 'running'>, report: string): AgentTask[] {
    const tasks = this.running(childId);
    if (!tasks.length) return [];
    this.store.run(`UPDATE agent_tasks SET status=?,report=?,finished_at=datetime('now') WHERE child_session_id=? AND status='running'`,
      status, report, childId);
    return tasks.map(task => ({ ...task, status, report }));
  }

  /** Ends a task that never reached the child; its failure went back to the master directly. */
  discard(id: string, reason: string): void {
    this.store.run(`UPDATE agent_tasks SET status='error',report=?,finished_at=datetime('now'),delivered_at=datetime('now')
      WHERE id=? AND status='running'`, reason, id);
  }

  /** Finished reports nobody has received yet. */
  pending(masterId: string, childIds?: string[]): AgentTask[] {
    const tasks = this.store.all<AgentTask>(`SELECT * FROM agent_tasks WHERE master_session_id=? AND status<>'running'
      AND delivered_at IS NULL ORDER BY finished_at,rowid`, masterId);
    return childIds ? tasks.filter(task => childIds.includes(task.child_session_id)) : tasks;
  }

  delivered(ids: string[]): void {
    for (const id of ids) this.store.run("UPDATE agent_tasks SET delivered_at=datetime('now') WHERE id=? AND delivered_at IS NULL", id);
  }

  latest(childId: string): AgentTask | undefined {
    return this.store.get<AgentTask>('SELECT * FROM agent_tasks WHERE child_session_id=? ORDER BY rowid DESC LIMIT 1', childId);
  }

  children(masterId: string): Session[] {
    return this.store.all<Session>('SELECT * FROM sessions WHERE parent_session_id=? ORDER BY created_at,rowid', masterId);
  }

  /** Children of the master, or of all the user's masters, with a task in progress. */
  busyChildren(filter: { masterId: string } | { userId: string }): Session[] {
    return 'masterId' in filter
      ? this.store.all<Session>(`SELECT DISTINCT sessions.* FROM sessions JOIN agent_tasks ON agent_tasks.child_session_id=sessions.id
        WHERE agent_tasks.master_session_id=? AND agent_tasks.status='running'`, filter.masterId)
      : this.store.all<Session>(`SELECT DISTINCT sessions.* FROM sessions JOIN agent_tasks ON agent_tasks.child_session_id=sessions.id
        WHERE sessions.user_id=? AND agent_tasks.status='running'`, filter.userId);
  }

  /** Report turns the master took since the user last wrote to it. */
  reportTurnsSinceUser(masterId: string): number {
    return this.store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM messages WHERE session_id=?1 AND source='report'
      AND rowid > COALESCE((SELECT MAX(rowid) FROM messages WHERE session_id=?1 AND role='user' AND source IS NULL),0)`, masterId)!.count;
  }
}
