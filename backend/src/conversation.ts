import { randomUUID } from 'node:crypto';
import type { Store } from './database.js';
import { copyImages } from './message-images.js';

export interface ActivityItem {
  id: string;
  /** `notice` reports the CLI retrying an API request; it is replaced in place, never part of the answer. */
  kind: 'text' | 'reasoning' | 'notice' | 'tool' | 'steer';
  text?: string;
  final?: boolean;
  /** Set on `steer` markers: the persisted user message consumed mid-turn, and when the engine consumed it. */
  messageId?: string;
  at?: string;
  /** `agent` names the subagent that made the call; absent for the conversation's own agent. */
  tool?: { id: string; name: string; input?: unknown; output?: string; status?: string; agent?: string };
}

export interface ConversationTurn {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  paused_at: string | null;
  paused_ms: number;
  slot_id: string | null;
  credential_revision: number | null;
  native_ref: string | null;
  native_session_id: string | null;
  native_inspect_tools: number;
  status: 'running' | 'pausing' | 'paused' | 'completed' | 'interrupted' | 'error';
  items: ActivityItem[];
}

type StoredTurn = Omit<ConversationTurn, 'items'> & { items: string };
interface PendingTurn { turn: ConversationTurn; timer?: NodeJS.Timeout }
const outputLimit = 128 * 1024;
const turnTextLimit = 2 * 1024 * 1024;
const truncated = '[此前输出已截断]\n';
const tail = (text: string, limit: number) => text.length > limit ? truncated + text.slice(-limit) : text;
/** Turn-level singleton items that always stay at the end of a turn, never sealed inside an earlier steer segment. */
const isTurnTailItem = (item: Pick<ActivityItem, 'id'>) => item.id === 'turn-diff' || item.id === 'native-plan';

function upsertActivityItem(items: ActivityItem[], next: ActivityItem): void {
  const index = items.findIndex(item => item.id === next.id);
  if (isTurnTailItem(next)) {
    if (index >= 0) items.splice(index, 1);
    items.push(next);
    return;
  }
  if (index >= 0) {
    Object.assign(items[index], next);
    return;
  }
  let insertAt = items.length;
  while (insertAt > 0 && isTurnTailItem(items[insertAt - 1])) insertAt--;
  items.splice(insertAt, 0, next);
}

function keepTurnTailAtEnd(items: ActivityItem[]): void {
  const head: ActivityItem[] = [];
  const trailing: ActivityItem[] = [];
  for (const item of items) (isTurnTailItem(item) ? trailing : head).push(item);
  if (!trailing.length) return;
  items.length = 0;
  items.push(...head, ...trailing);
}

export class ConversationStore {
  private active = new Map<string, PendingTurn>();

  constructor(private store: Store, private emit: (turn: ConversationTurn) => void) {}

  list(sessionId: string): ConversationTurn[] {
    return this.store.all<StoredTurn>('SELECT * FROM session_turns WHERE session_id=? ORDER BY rowid', sessionId)
      .map(row => this.active.get(sessionId)?.turn.id === row.id
        ? this.active.get(sessionId)!.turn : { ...row, items: JSON.parse(row.items) as ActivityItem[] });
  }

  start(sessionId: string, userMessageId: string, authorization: { slotId: string; credentialRevision: number }, turnId = userMessageId): ConversationTurn {
    const turn: ConversationTurn = {
      id: turnId, session_id: sessionId, user_message_id: userMessageId,
      assistant_message_id: null, started_at: new Date().toISOString(),
      completed_at: null, duration_ms: null, paused_at: null, paused_ms: 0, status: 'running', items: [],
      native_ref: null, native_session_id: null, native_inspect_tools: 0,
      slot_id: authorization.slotId, credential_revision: authorization.credentialRevision,
    };
    this.store.run('INSERT INTO session_turns(id,session_id,user_message_id,started_at,slot_id,credential_revision) VALUES(?,?,?,?,?,?)',
      turn.id, sessionId, userMessageId, turn.started_at, turn.slot_id, turn.credential_revision);
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
        agent: typeof payload.agent === 'string' ? payload.agent : previous?.agent,
      };
      const item: ActivityItem = { id, kind: 'tool', tool };
      upsertActivityItem(pending.turn.items, item);
    } else if (payload.kind === 'text' || payload.kind === 'reasoning' || payload.kind === 'notice') {
      const update = typeof payload.text === 'string' ? payload.text : '';
      const text = payload.append === true ? (existing?.text || '') + update : update || existing?.text || '';
      const item: ActivityItem = {
        id, kind: payload.kind, text: tail(text, 256 * 1024),
        final: typeof payload.final === 'boolean' ? payload.final : existing?.final,
      };
      upsertActivityItem(pending.turn.items, item);
    } else return false;
    const textSize = this.limitStoredText(pending.turn);
    if (!pending.timer) pending.timer = setTimeout(() => this.flush(sessionId), textSize > 128 * 1024 ? 500 : 250);
    return true;
  }

  /** Marks the exact point in the running turn where the engine consumed a mid-turn steering message. */
  steer(sessionId: string, messageId: string, turnId?: string): boolean {
    const pending = this.active.get(sessionId);
    if (!pending || !messageId || (turnId && pending.turn.id !== turnId)) return false;
    if (messageId === pending.turn.user_message_id) return false;
    const id = `steer:${messageId}`;
    if (pending.turn.items.some(item => item.id === id || (item.kind === 'steer' && item.messageId === messageId))) return false;
    upsertActivityItem(pending.turn.items, { id, kind: 'steer', messageId, at: new Date().toISOString() });
    this.flush(sessionId);
    return true;
  }

  /** Records where the running turn ends in the CLI's history, so that a branch can start there. */
  anchor(sessionId: string, turnId: string, ref: string, nativeSessionId: string, nativeInspectTools: number): void {
    const pending = this.active.get(sessionId);
    if (pending?.turn.id === turnId) Object.assign(pending.turn,
      { native_ref: ref, native_session_id: nativeSessionId, native_inspect_tools: nativeInspectTools });
    this.store.run('UPDATE session_turns SET native_ref=?,native_session_id=?,native_inspect_tools=? WHERE id=? AND session_id=?',
      ref, nativeSessionId, nativeInspectTools, turnId, sessionId);
  }

  clearNativeSession(sessionId: string): void {
    this.store.run(`UPDATE sessions SET native_session_id=NULL,fork_native_id=NULL,fork_native_anchor=NULL,jsonl_file_path=NULL,
      native_inspect_tools=0,token_usage_cursor=NULL,last_context_tokens=0,last_context_window=0,updated_at=datetime('now') WHERE id=?`, sessionId);
  }

  /** Copies the messages and turns up to and including `turnId` into another conversation, under new IDs. */
  copyHistory(sourceId: string, targetId: string, turnId: string): void {
    const turns = this.store.all<StoredTurn>('SELECT * FROM session_turns WHERE session_id=? ORDER BY rowid', sourceId);
    const index = turns.findIndex(turn => turn.id === turnId);
    if (index < 0) throw new Error('轮次不存在');
    const next = turns[index + 1];
    const boundary = next ? this.store.get<{ rowid: number }>('SELECT rowid FROM messages WHERE id=?', next.user_message_id)?.rowid ?? null : null;
    const messages = this.store.all<{ id: string; role: string; content: string; images: string | null; created_at: string }>(`SELECT
      id,role,content,images,created_at FROM messages WHERE session_id=? AND (?2 IS NULL OR rowid<?2) ORDER BY rowid`, sourceId, boundary);
    const copies = new Map<string, string>();
    for (const message of messages) {
      copies.set(message.id, randomUUID());
      this.store.run('INSERT INTO messages(id,session_id,role,content,images,created_at) VALUES(?,?,?,?,?,?)',
        copies.get(message.id)!, targetId, message.role, message.content, copyImages(this.store, message.images, targetId), message.created_at);
    }
    for (const turn of turns.slice(0, index + 1)) {
      const userMessageId = copies.get(turn.user_message_id);
      if (!userMessageId) continue;
      const items = (JSON.parse(turn.items) as ActivityItem[]).flatMap(item => {
        if (item.kind !== 'steer') return [item];
        const mapped = item.messageId ? copies.get(item.messageId) : undefined;
        return mapped && mapped !== userMessageId ? [{ ...item, id: `steer:${mapped}`, messageId: mapped }] : [];
      });
      keepTurnTailAtEnd(items);
      this.store.run(`INSERT INTO session_turns(id,session_id,user_message_id,assistant_message_id,started_at,completed_at,duration_ms,
        status,items,slot_id,credential_revision,paused_at,paused_ms,native_ref,native_session_id,native_inspect_tools) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(), targetId, userMessageId, turn.assistant_message_id ? copies.get(turn.assistant_message_id) ?? null : null,
      turn.started_at, turn.completed_at, turn.duration_ms, turn.status, JSON.stringify(items), turn.slot_id, turn.credential_revision,
      turn.paused_at, turn.paused_ms, turn.native_ref, turn.native_session_id, turn.native_inspect_tools);
    }
  }

  attachAnswer(sessionId: string, messageId: string): void {
    const pending = this.active.get(sessionId);
    if (pending) pending.turn.assistant_message_id = messageId;
  }

  setState(sessionId: string, status: 'running' | 'pausing' | 'paused', turnId?: string): void {
    const pending = this.active.get(sessionId);
    if (!pending || (turnId && pending.turn.id !== turnId)) return;
    const turn = pending.turn;
    const now = Date.now();
    if (turn.paused_at && status !== 'paused') {
      turn.paused_ms += Math.max(0, now - Date.parse(turn.paused_at));
      turn.paused_at = null;
    }
    if (status === 'paused' && !turn.paused_at) turn.paused_at = new Date(now).toISOString();
    turn.status = status;
    turn.duration_ms = status === 'paused'
      ? Math.max(0, Date.parse(turn.paused_at!) - Date.parse(turn.started_at) - turn.paused_ms) : null;
    this.flush(sessionId);
  }

  finish(sessionId: string, status: ConversationTurn['status'], turnId?: string): void {
    const pending = this.active.get(sessionId);
    if (!pending || (turnId && pending.turn.id !== turnId)) return;
    if (pending.turn.paused_at) {
      pending.turn.paused_ms += Math.max(0, Date.now() - Date.parse(pending.turn.paused_at));
      pending.turn.paused_at = null;
    }
    pending.turn.status = status;
    pending.turn.completed_at = new Date().toISOString();
    pending.turn.duration_ms = Math.max(0, Date.now() - Date.parse(pending.turn.started_at) - pending.turn.paused_ms);
    for (const item of pending.turn.items) {
      if (item.tool && ['running', 'waiting'].includes(item.tool.status || ''))
        item.tool.status = status === 'completed' ? 'completed' : status;
    }
    this.cleanSteerMarkers(sessionId, pending.turn);
    keepTurnTailAtEnd(pending.turn.items);
    this.flush(sessionId);
    this.active.delete(sessionId);
  }

  /**
   * Removes invalid or orphan `steer` markers while keeping valid ones whenever the turn recorded any activity,
   * including when a steer occurred right before the final reply so pre-steer items stay above the steer message.
   */
  private cleanSteerMarkers(sessionId: string, turn: ConversationTurn): void {
    const candidateIds = [...new Set(turn.items
      .filter(item => item.kind === 'steer' && typeof item.messageId === 'string' && item.messageId && item.messageId !== turn.user_message_id)
      .map(item => item.messageId!))];
    if (!candidateIds.length && !turn.items.some(item => item.kind === 'steer')) return;
    const hasActivity = turn.items.some(item => item.kind !== 'steer');
    if (!hasActivity) {
      turn.items = [];
      return;
    }
    const existingIds = candidateIds.length
      ? new Set(this.store.all<{ id: string }>(
        `SELECT id FROM messages WHERE session_id=? AND id IN (${candidateIds.map(() => '?').join(',')})`,
        sessionId, ...candidateIds,
      ).map(row => row.id))
      : new Set<string>();
    const seen = new Set<string>();
    turn.items = turn.items.filter(item => {
      if (item.kind !== 'steer') return true;
      if (!item.messageId || item.messageId === turn.user_message_id || !existingIds.has(item.messageId) || seen.has(item.messageId)) {
        return false;
      }
      seen.add(item.messageId);
      return true;
    });
  }

  private flush(sessionId: string): void {
    const pending = this.active.get(sessionId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    const turn = pending.turn;
    this.store.run('UPDATE session_turns SET assistant_message_id=?,completed_at=?,duration_ms=?,paused_at=?,paused_ms=?,status=?,items=? WHERE id=?',
      turn.assistant_message_id, turn.completed_at, turn.duration_ms, turn.paused_at, turn.paused_ms, turn.status, JSON.stringify(turn.items), turn.id);
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
