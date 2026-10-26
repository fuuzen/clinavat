import { randomUUID } from 'node:crypto';
import type { Store } from './database.js';

export interface ActivityItem {
  id: string;
  kind: 'text' | 'reasoning' | 'tool';
  text?: string;
  final?: boolean;
  tool?: { id: string; name: string; input?: unknown; output?: string; status?: string };
}

export interface ConversationTurn {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: 'running' | 'completed' | 'interrupted' | 'error';
  items: ActivityItem[];
}

type StoredTurn = Omit<ConversationTurn, 'items'> & { items: string };
interface PendingTurn { turn: ConversationTurn; timer?: NodeJS.Timeout }
const outputLimit = 128 * 1024;
const turnTextLimit = 2 * 1024 * 1024;
const truncated = '[此前输出已截断]\n';
const tail = (text: string, limit: number) => text.length > limit ? truncated + text.slice(-limit) : text;

export class ConversationStore {
  private active = new Map<string, PendingTurn>();

  constructor(private store: Store, private emit: (turn: ConversationTurn) => void) {}

  list(sessionId: string): ConversationTurn[] {
    return this.store.all<StoredTurn>('SELECT * FROM session_turns WHERE session_id=? ORDER BY rowid', sessionId)
      .map(row => this.active.get(sessionId)?.turn.id === row.id
        ? this.active.get(sessionId)!.turn : { ...row, items: JSON.parse(row.items) as ActivityItem[] });
  }

  start(sessionId: string, userMessageId: string): ConversationTurn {
    const turn: ConversationTurn = {
      id: userMessageId, session_id: sessionId, user_message_id: userMessageId,
      assistant_message_id: null, started_at: new Date().toISOString(),
      completed_at: null, duration_ms: null, status: 'running', items: [],
    };
    this.store.run('INSERT INTO session_turns(id,session_id,user_message_id,started_at) VALUES(?,?,?,?)',
      turn.id, sessionId, userMessageId, turn.started_at);
    this.active.set(sessionId, { turn });
    this.emit(turn);
    return turn;
  }

  record(sessionId: string, type: string, value: unknown): boolean {
    const pending = this.active.get(sessionId);
    if (!pending || !value || typeof value !== 'object') return false;
    const payload = value as Record<string, unknown>;
    if (typeof payload.turnId === 'string' && payload.turnId !== pending.turn.id) return false;
    if (type !== 'tool' && type !== 'activity') return false;
    const id = String(payload.id || randomUUID());
    const existing = pending.turn.items.find(item => item.id === id);
    if (type === 'tool') {
      const previous = existing?.tool;
      const update = typeof payload.output === 'string' ? payload.output
        : payload.output !== undefined ? JSON.stringify(payload.output) : undefined;
      const output = payload.append === true && update !== undefined
        ? (previous?.output || '') + update : update ?? previous?.output;
      const tool: ActivityItem['tool'] = {
        id, name: String(payload.name || payload.tool || previous?.name || '工具调用'),
        input: payload.input ?? previous?.input,
        output: output === undefined ? undefined : tail(output, outputLimit),
        status: typeof payload.status === 'string' ? payload.status : previous?.status,
      };
      const item: ActivityItem = { id, kind: 'tool', tool };
      if (existing) Object.assign(existing, item);
      else pending.turn.items.push(item);
    } else if (payload.kind === 'text' || payload.kind === 'reasoning') {
      const update = typeof payload.text === 'string' ? payload.text : '';
      const text = payload.append === true ? (existing?.text || '') + update : update || existing?.text || '';
      const item: ActivityItem = {
        id, kind: payload.kind, text: tail(text, 256 * 1024),
        final: typeof payload.final === 'boolean' ? payload.final : existing?.final,
      };
      if (existing) Object.assign(existing, item);
      else pending.turn.items.push(item);
    } else return false;
    const textSize = this.limitStoredText(pending.turn);
    if (!pending.timer) pending.timer = setTimeout(() => this.flush(sessionId), textSize > 128 * 1024 ? 500 : 250);
    return true;
  }

  attachAnswer(sessionId: string, messageId: string): void {
    const pending = this.active.get(sessionId);
    if (pending) pending.turn.assistant_message_id = messageId;
  }

  finish(sessionId: string, status: ConversationTurn['status'], turnId?: string): void {
    const pending = this.active.get(sessionId);
    if (!pending || (turnId && pending.turn.id !== turnId)) return;
    pending.turn.status = status;
    pending.turn.completed_at = new Date().toISOString();
    pending.turn.duration_ms = Math.max(0, Date.now() - Date.parse(pending.turn.started_at));
    for (const item of pending.turn.items) {
      if (item.tool && ['running', 'waiting'].includes(item.tool.status || ''))
        item.tool.status = status === 'completed' ? 'completed' : status;
    }
    this.flush(sessionId);
    this.active.delete(sessionId);
  }

  private flush(sessionId: string): void {
    const pending = this.active.get(sessionId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    const turn = pending.turn;
    this.store.run('UPDATE session_turns SET assistant_message_id=?,completed_at=?,duration_ms=?,status=?,items=? WHERE id=?',
      turn.assistant_message_id, turn.completed_at, turn.duration_ms, turn.status, JSON.stringify(turn.items), turn.id);
    this.emit(turn);
  }

  private limitStoredText(turn: ConversationTurn): number {
    const textSize = turn.items.reduce((size, item) => size + (item.text?.length || 0) + (item.tool?.output?.length || 0), 0);
    let excess = textSize - turnTextLimit;
    for (const item of turn.items) {
      if (excess <= 0) break;
      if (item.tool?.output && item.tool.output.length > truncated.length) {
        const removed = Math.min(excess + truncated.length, item.tool.output.length);
        item.tool.output = truncated + item.tool.output.slice(removed);
        excess -= removed - truncated.length;
      } else if (item.text && item.text.length > truncated.length) {
        const removed = Math.min(excess + truncated.length, item.text.length);
        item.text = truncated + item.text.slice(removed);
        excess -= removed - truncated.length;
      }
    }
    return Math.min(textSize, turnTextLimit);
  }
}
