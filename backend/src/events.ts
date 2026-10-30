import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { HttpError, type PoolEvent } from './models.js';
import type { Store } from './database.js';
import type { ConnectionRegistry } from './connections.js';

interface Decision { decision: 'allow' | 'deny'; reason?: string }
export class EventBus {
  private clients = new Map<string, Set<ServerResponse>>();
  private pending = new Map<string, { resolve: (value: Decision) => void; cancelTimeout: () => void; cleanup: () => void }>();
  constructor(private store: Store, private timeout: number) {}
  emit(userId: string, event: PoolEvent) {
    const result = this.store.run('INSERT INTO events(user_id,type,session_id,payload) VALUES(?,?,?,?)', userId, event.type, event.sessionId ?? null, JSON.stringify(event.payload));
    const data = `id: ${result.lastInsertRowid}\ndata: ${JSON.stringify(event)}\n\n`;
    this.send(userId, data);
    if (Number(result.lastInsertRowid) % 1000 === 0) this.store.run('DELETE FROM events WHERE id < ?', Number(result.lastInsertRowid) - 50000);
  }
  broadcast(userId: string, event: PoolEvent) {
    this.send(userId, `data: ${JSON.stringify(event)}\n\n`);
  }
  private send(userId: string, data: string) {
    for (const response of this.clients.get(userId) ?? []) {
      if (response.writableEnded || response.destroyed) this.clients.get(userId)?.delete(response);
      else if (response.writableLength > 1024 * 1024) response.destroy();
      else response.write(data);
    }
  }
  register(app: FastifyInstance, connections: ConnectionRegistry) {
    app.get('/api/events', async (request, reply) => {
      const responses = this.clients.get(request.user.id) ?? new Set<ServerResponse>();
      if (responses.size >= 8) throw new HttpError(429, '实时连接过多');
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');
      const cursor = Number(request.headers['last-event-id'] ?? 0);
      if (Number.isSafeInteger(cursor) && cursor > 0) {
        const events = this.store.all<{ id: number; type: string; session_id: string | null; payload: string }>(
          'SELECT * FROM events WHERE user_id=? AND id>? ORDER BY id DESC LIMIT 500', request.user.id, cursor,
        );
        for (const event of events.reverse()) response.write(`id: ${event.id}\ndata: ${JSON.stringify({ type: event.type, sessionId: event.session_id, payload: JSON.parse(event.payload) })}\n\n`);
      }
      responses.add(response);
      this.clients.set(request.user.id, responses);
      const unwatch = connections.watch(request.authSessionHash, () => response.end());
      const heartbeat = setInterval(() => { if (!response.writableEnded && !response.destroyed) response.write(': heartbeat\n\n'); }, 20000);
      const cleanup = () => {
        unwatch();
        clearInterval(heartbeat); responses.delete(response);
        if (!responses.size) this.clients.delete(request.user.id);
      };
      response.once('close', cleanup);
      response.once('error', cleanup);
    });
  }
  requestApproval(userId: string, input: { sessionId: string; tool: string; input: unknown; signal?: AbortSignal;
    scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void }): Promise<Decision> {
    if (input.signal?.aborted) return Promise.resolve({ decision: 'deny', reason: '审批已取消' });
    const id = randomUUID();
    this.store.run('INSERT INTO approvals(id,session_id,user_id,tool,input) VALUES(?,?,?,?,?)', id, input.sessionId, userId, input.tool, JSON.stringify(input.input));
    const approval = this.store.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id=?', id)!;
    const promise = new Promise<Decision>(resolve => {
      const expire = () => this.resolveApproval(userId, id, { decision: 'deny', reason: '审批超时，已拒绝执行' }, 'expired');
      const cancelTimeout = input.scheduleTimeout ? input.scheduleTimeout(expire, this.timeout)
        : (() => { const timer = setTimeout(expire, this.timeout); return () => clearTimeout(timer); })();
      const abort = () => this.resolveApproval(userId, id, { decision: 'deny', reason: '审批已取消' }, 'cancelled');
      const cleanup = () => input.signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, cancelTimeout, cleanup });
      input.signal?.addEventListener('abort', abort, { once: true });
    });
    this.emit(userId, { type: 'approval', sessionId: input.sessionId, payload: { ...approval, input: input.input } });
    return promise;
  }
  resolveApproval(userId: string, id: string, decision: Decision, status?: string) {
    const approval = this.store.get<{ session_id: string; status: string }>('SELECT * FROM approvals WHERE id=? AND user_id=?', id, userId);
    if (!approval) throw new HttpError(404, '审批不存在');
    const pending = this.pending.get(id);
    if (!pending || approval.status !== 'pending') throw new HttpError(409, '该审批已结束');
    pending.cancelTimeout(); pending.cleanup(); this.pending.delete(id);
    this.store.run('UPDATE approvals SET status=?,reason=? WHERE id=?', status ?? decision.decision, decision.reason ?? null, id);
    this.emit(userId, { type: 'approval', sessionId: approval.session_id, payload: { id, status: status ?? decision.decision, reason: decision.reason } });
    pending.resolve(decision);
  }
  cancelSession(userId: string, sessionId: string) {
    for (const approval of this.store.all<{ id: string }>("SELECT id FROM approvals WHERE user_id=? AND session_id=? AND status='pending'", userId, sessionId)) {
      if (this.pending.has(approval.id)) this.resolveApproval(userId, approval.id, { decision: 'deny', reason: '会话已停止' });
    }
  }
  close() {
    for (const item of this.pending.values()) { item.cancelTimeout(); item.cleanup(); item.resolve({ decision: 'deny', reason: '服务关闭' }); }
    this.pending.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const responses of clients) for (const response of responses) response.end();
  }
}
