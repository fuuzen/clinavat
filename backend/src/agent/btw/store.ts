import type { Store } from '../../database.js';
import type { AgentEngine } from '../engines.js';
import type { BtwExchange, BtwHistoryEntry, BtwStatus } from './types.js';

const MAX_STORED_ANSWER_CHARS = 256 * 1024;

function clampAnswer(text: string): string {
  return text.length > MAX_STORED_ANSWER_CHARS ? `${text.slice(0, MAX_STORED_ANSWER_CHARS)}\n\n[回答过长，已截断]` : text;
}

export class BtwStore {
  constructor(private store: Store) {}

  list(sessionId: string): BtwExchange[] {
    return this.store.all<BtwExchange>(
      'SELECT * FROM session_btw_exchanges WHERE session_id=? ORDER BY created_at ASC, rowid ASC',
      sessionId,
    );
  }

  get(sessionId: string, id: string): BtwExchange | undefined {
    return this.store.get<BtwExchange>(
      'SELECT * FROM session_btw_exchanges WHERE session_id=? AND id=?',
      sessionId,
      id,
    );
  }

  create(input: {
    id: string;
    sessionId: string;
    question: string;
    engine: AgentEngine;
    model: string | null;
    slotId: string | null;
  }): BtwExchange {
    const now = new Date().toISOString();
    this.store.run(
      `INSERT INTO session_btw_exchanges(id,session_id,question,answer,status,error,engine,model,slot_id,created_at,completed_at)
       VALUES(?,?,?,'','running',NULL,?,?,?,?,NULL)`,
      input.id,
      input.sessionId,
      input.question,
      input.engine,
      input.model,
      input.slotId,
      now,
    );
    return this.get(input.sessionId, input.id)!;
  }

  updateAnswer(id: string, answer: string): void {
    this.store.run(
      "UPDATE session_btw_exchanges SET answer=? WHERE id=? AND status='running'",
      clampAnswer(answer),
      id,
    );
  }

  finish(
    sessionId: string,
    id: string,
    status: Exclude<BtwStatus, 'running'>,
    fields: { answer?: string; error?: string | null },
  ): BtwExchange | undefined {
    const existing = this.get(sessionId, id);
    if (!existing) return undefined;
    const completedAt = new Date().toISOString();
    const answer = fields.answer !== undefined ? clampAnswer(fields.answer) : existing.answer;
    const error = fields.error === undefined ? existing.error : fields.error;
    this.store.run(
      'UPDATE session_btw_exchanges SET status=?,answer=?,error=?,completed_at=? WHERE id=? AND session_id=?',
      status,
      answer,
      error,
      completedAt,
      id,
      sessionId,
    );
    return this.get(sessionId, id);
  }

  remove(sessionId: string, id: string): boolean {
    const existing = this.get(sessionId, id);
    if (!existing) return false;
    this.store.run('DELETE FROM session_btw_exchanges WHERE id=? AND session_id=?', id, sessionId);
    return true;
  }

  recentCompleted(sessionId: string, limit = 6, excludeId?: string): BtwHistoryEntry[] {
    const rows = this.store.all<{ question: string; answer: string }>(
      `SELECT question, answer FROM (
         SELECT rowid, question, answer FROM session_btw_exchanges
         WHERE session_id=? AND status='completed' AND answer<>'' AND (? IS NULL OR id<>?)
         ORDER BY rowid DESC LIMIT ?
       ) ORDER BY rowid ASC`,
      sessionId,
      excludeId ?? null,
      excludeId ?? null,
      limit,
    );
    return rows.map(row => ({
      question: row.question.slice(0, 2000),
      response: row.answer.slice(0, 4000),
    }));
  }
}
