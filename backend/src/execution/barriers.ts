import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readJsonLines } from '../agent/ndjson.js';
import type { Machine } from './lxd-host.js';

interface BarrierHooks {
  /** Starts the relay in a slot machine; its stdio carries barrier requests. */
  relay(machine: Machine): ChildProcessWithoutNullStreams;
  /** Starts the user's flush worker in their workspace machine. */
  worker(userId: string): Promise<ChildProcessWithoutNullStreams>;
  project(userId: string, syncName: string): string | undefined;
  /** Makes the project directory visible in the workspace machine before Mutagen flushes it. */
  prepareProject(userId: string, path: string): Promise<void>;
}
interface Request { id: number; op: 'ready' | 'begin' | 'end' | 'abort'; conn?: number; sync?: string; lock?: boolean }
interface Relay { child: ChildProcessWithoutNullStreams; userId: string; closed: boolean; connections: Map<number, { sync: string; release?: () => void }> }
interface Worker { child: Promise<ChildProcessWithoutNullStreams>; pending: Map<number, { resolve(): void; reject(error: Error): void }> }

const LOCK_TIMEOUT_MS = 120_000;
const FLUSH_TIMEOUT_MS = 130_000;

/** One project command at a time, across every machine that runs commands for the project. */
class ProjectLocks {
  private tails = new Map<string, Promise<void>>();

  acquire(key: string, timeoutMs: number): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error('another project command is still running; lock acquisition timed out'));
      }, timeoutMs);
      // A caller that gave up still takes its turn, and passes it on immediately.
      void previous.then(() => {
        clearTimeout(timer);
        if (expired) { release(); return; }
        let released = false;
        resolve(() => { if (!released) { released = true; release(); } });
      });
    });
  }
}

/**
 * Sync barriers for commands that run in slot machines while the user's Mutagen daemon runs in their workspace
 * machine. Machines never talk to each other: each request travels over the Hub's own exec channels.
 */
export class SyncBarriers {
  private readonly relays = new Map<string, Relay>();
  private readonly workers = new Map<string, Worker>();
  private readonly locks = new ProjectLocks();
  private sequence = 0;

  constructor(private readonly hooks: BarrierHooks) {}

  /** Keeps a relay running in the slot machine for its current user. */
  ensure(machine: Machine, userId: string): void {
    const existing = this.relays.get(machine.name);
    if (existing && !existing.closed && existing.userId === userId) return;
    if (existing) this.stop(existing);
    const relay: Relay = { child: this.hooks.relay(machine), userId, closed: false, connections: new Map() };
    this.relays.set(machine.name, relay);
    const lines = readJsonLines(relay.child.stdout, message => { void this.handle(relay, message as Request); }, () => relay.child.kill());
    relay.child.stderr.resume();
    relay.child.once('close', () => {
      lines.close();
      for (const connection of relay.connections.values()) connection.release?.();
      relay.connections.clear();
      if (this.relays.get(machine.name) !== relay) return;
      this.relays.delete(machine.name);
      // An unexpected exit while the user still holds the machine would fail every later remote command.
      if (!relay.closed && machine.occupant === userId) setTimeout(() => { if (machine.occupant === userId) this.ensure(machine, userId); }, 1000).unref();
    });
  }

  /** Stops the relay before the machine changes hands. */
  close(machine: Machine): void {
    const relay = this.relays.get(machine.name);
    if (relay) this.stop(relay);
    this.relays.delete(machine.name);
  }

  private stop(relay: Relay): void {
    relay.closed = true;
    relay.child.kill();
  }

  private reply(relay: Relay, id: number, error?: unknown): void {
    if (relay.closed || relay.child.stdin.destroyed) return;
    relay.child.stdin.write(JSON.stringify(error === undefined ? { id, ok: true }
      : { id, ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
  }

  private async handle(relay: Relay, message: Request): Promise<void> {
    const conn = Number(message.conn);
    if (message.op === 'abort') {
      relay.connections.get(conn)?.release?.();
      relay.connections.delete(conn);
      return;
    }
    if (message.op !== 'begin' && message.op !== 'end') return;
    try {
      if (message.op === 'begin') {
        const sync = String(message.sync ?? '');
        const path = this.hooks.project(relay.userId, sync);
        if (!path) throw new Error('同步会话不属于当前用户');
        const connection: { sync: string; release?: () => void } = { sync };
        relay.connections.set(conn, connection);
        if (message.lock) connection.release = await this.locks.acquire(sync, LOCK_TIMEOUT_MS);
        if (relay.closed || !relay.connections.has(conn)) { connection.release?.(); return; }
        try { await this.flush(relay.userId, sync, path); }
        catch (error) { connection.release?.(); relay.connections.delete(conn); throw error; }
      } else {
        const connection = relay.connections.get(conn);
        if (!connection) throw new Error('同步屏障尚未开始');
        relay.connections.delete(conn);
        try { await this.flush(relay.userId, connection.sync, this.hooks.project(relay.userId, connection.sync)!); }
        finally { connection.release?.(); }
      }
      this.reply(relay, message.id);
    } catch (error) {
      this.reply(relay, message.id, error);
    }
  }

  private worker(userId: string): Worker {
    let worker = this.workers.get(userId);
    if (worker) return worker;
    const pending: Worker['pending'] = new Map();
    const created: Worker = { pending, child: this.hooks.worker(userId) };
    worker = created;
    this.workers.set(userId, worker);
    const forget = (error: Error) => {
      if (this.workers.get(userId) === created) this.workers.delete(userId);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    created.child.then(child => {
      const lines = readJsonLines(child.stdout, value => {
        const message = value as { id: number; ok: boolean; error?: string };
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) entry?.resolve();
        else entry?.reject(new Error(`synchronization barrier failed: ${(message.error ?? '').trim().slice(-500)}`));
      }, () => child.kill());
      child.stderr.resume();
      child.once('close', () => { lines.close(); forget(new Error('同步服务已退出，请重试')); });
    }, (error: unknown) => forget(error instanceof Error ? error : new Error('无法启动同步服务')));
    return worker;
  }

  private async flush(userId: string, sync: string, path: string): Promise<void> {
    await this.hooks.prepareProject(userId, path);
    const worker = this.worker(userId);
    const child = await worker.child;
    const id = ++this.sequence;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { worker.pending.delete(id); reject(new Error('synchronization barrier timed out')); }, FLUSH_TIMEOUT_MS);
      worker.pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id, sync }) + '\n');
    });
  }
}
