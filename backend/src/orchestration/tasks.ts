import { randomUUID } from 'node:crypto';
import type { Store } from '../database.js';
import type { Session } from '../models.js';

export type TaskStatus = 'running' | 'completed' | 'interrupted' | 'error';

export interface AgentTask {
  id: string; master_session_id: string; child_session_id: string; prompt: string; status: TaskStatus;
  report: string | null; notify: 0 | 1; created_at: string; finished_at: string | null; delivered_at: string | null;
  work_item_id: string | null; wave: string | null;
}

/** Each message a master sends a child is a task; it ends, with the child's reply as its report, when the child goes idle. */
export class AgentTasks {
  constructor(private readonly store: Store) {}

  create(masterId: string, childId: string, prompt: string, notify: boolean, workItemId?: string, wave?: string): AgentTask {
    const id = randomUUID();
    this.store.run('INSERT INTO agent_tasks(id,master_session_id,child_session_id,prompt,notify,work_item_id,wave) VALUES(?,?,?,?,?,?,?)',
      id, masterId, childId, prompt, notify ? 1 : 0, workItemId ?? null, notify ? wave ?? null : null);
    return this.store.get<AgentTask>('SELECT * FROM agent_tasks WHERE id=?', id)!;
  }

  running(childId: string): AgentTask[] {
    return this.store.all<AgentTask>("SELECT * FROM agent_tasks WHERE child_session_id=? AND status='running' ORDER BY rowid", childId);
  }

  waveRunning(masterId: string, wave: string): boolean {
    return !!this.store.get("SELECT 1 FROM agent_tasks WHERE master_session_id=? AND wave=? AND status='running' LIMIT 1", masterId, wave);
  }

  /** Ends the given tasks the child was working on with the same outcome, and returns those still running until now. */
  finish(childId: string, status: Exclude<TaskStatus, 'running'>, report: string, ids: string[]): AgentTask[] {
    const tasks = this.running(childId).filter(task => ids.includes(task.id));
    for (const task of tasks) {
      this.store.run(`UPDATE agent_tasks SET status=?,report=?,finished_at=datetime('now') WHERE id=? AND status='running'`, status, report, task.id);
    }
    return tasks.map(task => ({ ...task, status, report }));
  }

  /** Ends a task that never reached the child; its failure went back to the master directly. */
  discard(id: string, reason: string): void {
    this.store.run(`UPDATE agent_tasks SET status='error',report=?,finished_at=datetime('now'),delivered_at=datetime('now'),work_item_id=NULL
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

  latestWorkItem(childId: string): string | undefined {
    return this.store.get<{ work_item_id: string }>(`SELECT work_item_id FROM agent_tasks
      WHERE child_session_id=? AND work_item_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`, childId)?.work_item_id;
  }

  read(child: Session, count: number, includeTools: boolean, superAgent: boolean) {
    const task = this.store.get<{ created_at: string; elapsed_seconds: number }>(`SELECT created_at,
      MAX(0,unixepoch('now')-unixepoch(created_at)) AS elapsed_seconds
      FROM agent_tasks WHERE child_session_id=? AND status='running' ORDER BY rowid LIMIT 1`, child.id);
    const identity = { agent: child.agent_name, engine: child.engine, status: child.status, running: !!task };
    if (superAgent && task) {
      const recent = this.store.all<{ name: string }>(`SELECT json_extract(value,'$.tool.name') AS name FROM json_each(
        (SELECT items FROM session_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1))
        WHERE json_type(value,'$.tool.name')='text' ORDER BY key DESC LIMIT 3`, child.id);
      return { ...identity, taskCreatedAt: task.created_at, elapsedSeconds: task.elapsed_seconds,
        recentTools: recent.reverse().map(tool => tool.name),
        note: '子智能体仍在运行中，请等待异步汇报到达，勿频繁轮询' };
    }
    const turns = this.store.all<{ status: string; items: string; task: string | null; answer: string | null }>(`
      SELECT session_turns.status,session_turns.items,asked.content AS task,answered.content AS answer FROM session_turns
      LEFT JOIN messages asked ON asked.id=session_turns.user_message_id
      LEFT JOIN messages answered ON answered.id=session_turns.assistant_message_id
      WHERE session_turns.session_id=? ORDER BY session_turns.rowid DESC LIMIT ?`, child.id, count).reverse();
    return { ...identity, model: child.model ?? 'default', turns: turns.map(turn => ({
      status: turn.status, message: turn.task?.slice(0, 4000) ?? null, reply: turn.answer ?? null,
      ...(includeTools ? { tools: activityTools(turn.items).slice(-80).map(tool => ({
        name: tool.name, status: tool.status, ...(typeof tool.input?.file_path === 'string' ? { file: tool.input.file_path } : {}),
      })) } : {}),
    })) };
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

  /** Automatic report turns after the latest user message or manual delivery. */
  reportTurnsSinceUser(masterId: string, anchorMessageId?: string): number {
    return this.store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM messages WHERE session_id=?1 AND source='report'
      AND rowid > MAX(COALESCE((SELECT MAX(rowid) FROM messages WHERE session_id=?1 AND role='user' AND source IS NULL),0),
        COALESCE((SELECT rowid FROM messages WHERE session_id=?1 AND id=?2),0))`, masterId, anchorMessageId ?? null)!.count;
  }
}

function activityTools(items: string) {
  return (JSON.parse(items) as { tool?: { name: string; status?: string; input?: Record<string, unknown> } }[])
    .flatMap(item => item.tool ? [item.tool] : []);
}
