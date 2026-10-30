import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type RunState = 'running' | 'pausing' | 'paused';
export interface NativeRunDriver {
  pause(): Promise<void>;
  resume(): Promise<void>;
  close?(): void;
}
interface ProcessIdentity { pid: number; start: string }
interface ProcessInfo extends ProcessIdentity { parent: number; group: number; status: string }
interface Root { child: ChildProcess; identity?: ProcessIdentity }
interface Gate { resolve(): void; reject(error: Error): void }

function processInfo(pid: number, contents: string): ProcessInfo {
  const fields = contents.slice(contents.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error(`无法识别进程 ${pid}`);
  return { pid, start: fields[19], parent: Number(fields[1]), group: Number(fields[2]), status: fields[0]! };
}

const exited = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
const live = (info: ProcessInfo) => !['Z', 'X', 'x'].includes(info.status);
const stopped = (info: ProcessInfo) => ['T', 't'].includes(info.status);
const same = (first: ProcessIdentity, second: ProcessIdentity) => first.pid === second.pid && first.start === second.start;

// A PID can outlive its original child process handle. Verify its birth time before every signal.
function signalProcess(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
  if (identity.pid === process.pid) throw new Error('不能暂停 Hub 进程');
  try {
    const current = processInfo(identity.pid, readFileSync(`/proc/${identity.pid}/stat`, 'utf8'));
    if (!same(identity, current) || !live(current)) return false;
    process.kill(identity.pid, signal);
    return true;
  } catch (error) {
    if (exited(error)) return false;
    throw error;
  }
}

async function snapshot(): Promise<Map<number, ProcessInfo>> {
  const entries = await readdir('/proc');
  const records = await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(async name => {
    try { return processInfo(Number(name), await readFile(`/proc/${name}/stat`, 'utf8')); }
    catch (error) { if (exited(error)) return undefined; throw error; }
  }));
  return new Map(records.filter((record): record is ProcessInfo => !!record && live(record)).map(record => [record.pid, record]));
}

async function remoteExecution(info: ProcessInfo): Promise<boolean> {
  let contents: string;
  try { contents = await readFile(`/proc/${info.pid}/cmdline`, 'utf8'); }
  catch (error) { if (exited(error)) return false; throw error; }
  const arguments_ = contents.split('\0').filter(Boolean);
  const executable = path.basename(arguments_[0] ?? '');
  if (['ssh', 'sshpass', 'mutagen', 'remote-shell', 'timeout'].includes(executable)) return true;
  // Inspect shell commands only; CLI system instructions may themselves mention remote-shell.
  if (['bash', 'sh', 'dash', 'zsh'].includes(executable)) {
    if (path.basename(arguments_[1] ?? '') === 'remote-shell') return true;
    const commandIndex = arguments_.findIndex(argument => /^-[a-z]*c[a-z]*$/.test(argument));
    if (commandIndex >= 0) return /remote-shell|\b(?:ssh|mutagen|timeout)\b/.test(arguments_[commandIndex + 1] ?? '');
  }
  return false;
}

export class RunControl {
  private current: RunState = 'running';
  private roots = new Set<Root>();
  private frozen = new Map<number, ProcessIdentity>();
  private listeners = new Set<(state: RunState) => void>();
  private gates = new Set<Gate>();
  private timers = new Set<() => void>();
  private generation = 0;
  private holds = 0;
  private pending?: Promise<void>;
  private resuming?: Promise<void>;
  private native?: NativeRunDriver;
  private closed = false;
  private cancelClose!: () => void;
  private closedSignal = new Promise<void>(resolve => { this.cancelClose = resolve; });

  get state(): RunState { return this.current; }

  track(child: ChildProcess): () => void {
    if (this.closed) throw new Error('运行控制已关闭');
    const root: Root = { child };
    this.roots.add(root);
    const remove = () => { this.roots.delete(root); child.removeListener('close', remove); };
    child.once('close', remove);
    return remove;
  }

  subscribe(listener: (state: RunState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setNative(driver: NativeRunDriver): void {
    if (this.closed || this.current !== 'running' || this.pending || this.resuming || this.native) {
      throw new Error('当前执行不能更换原生暂停驱动');
    }
    this.native = driver;
  }

  pause(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('运行控制已关闭'));
    if (this.resuming) return this.resuming.then(() => this.pause());
    if (!this.native && process.platform !== 'linux') return Promise.reject(new Error('原位暂停需要 Linux /proc 支持'));
    if (this.current === 'paused') return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    this.publish('pausing');
    const work = this.native ? this.pauseNative(this.native, generation) : this.freeze(generation);
    const pending = work.catch(async error => {
      if (this.generation === generation && !this.closed) {
        if (this.native) this.openGates();
        else await this.resume();
      }
      if (!this.closed) throw error;
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  resume(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.resuming) return this.resuming;
    if (!this.native) {
      ++this.generation;
      this.pending = undefined;
      try { this.thaw(); this.openGates(); return Promise.resolve(); }
      catch (error) { return Promise.reject(error); }
    }
    if (this.current === 'running' && !this.pending) return Promise.resolve();
    const driver = this.native;
    const pause = this.pending;
    const work = (async () => {
      if (pause) {
        try { if (!await this.untilClosed(pause)) return; }
        catch { return; }
      }
      if (this.closed || this.current === 'running') return;
      const resumed = await this.untilClosed(Promise.resolve().then(() => {
        if (!this.closed) return driver.resume();
      }));
      if (resumed && !this.closed) this.openGates();
    })().catch(error => { if (!this.closed) throw error; })
      .finally(() => { if (this.resuming === work) this.resuming = undefined; });
    this.resuming = work;
    return work;
  }

  close(): void {
    if (this.closed && !this.frozen.size) return;
    this.closed = true;
    ++this.generation;
    this.cancelClose();
    let failure: unknown;
    try { this.native?.close?.(); } catch (error) { failure = error; }
    try { this.thaw(); } catch (error) { failure ??= error; }
    for (const cancel of [...this.timers]) cancel();
    for (const gate of [...this.gates]) gate.reject(new Error('会话已结束'));
    this.listeners.clear();
    this.roots.clear();
    if (failure) throw failure;
  }

  waitUntilRunning(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('会话已停止'));
    if (this.closed) return Promise.reject(new Error('会话已结束'));
    if (this.current === 'running') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.gates.delete(gate); signal?.removeEventListener('abort', abort); };
      const gate: Gate = {
        resolve: () => { cleanup(); resolve(); },
        reject: error => { cleanup(); reject(error); },
      };
      const abort = () => gate.reject(new Error('会话已停止'));
      this.gates.add(gate);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  // Acquire immediately after waitUntilRunning; already admitted Hub writes must finish before a freeze.
  hold(): () => void {
    if (this.closed) throw new Error('运行控制已关闭');
    if (this.current === 'paused') throw new Error('请先等待执行恢复，再开始工具操作');
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
    };
  }

  // Pausing still lets in-flight remote work settle; only a confirmed freeze suspends deadlines.
  timer(callback: () => void, milliseconds: number): () => void {
    let remaining = Math.max(0, milliseconds);
    let started = 0;
    let handle: NodeJS.Timeout | undefined;
    let cancelled = false;
    const update = () => {
      if (handle) {
        clearTimeout(handle);
        handle = undefined;
        remaining = Math.max(0, remaining - (performance.now() - started));
      }
      if (cancelled || this.current === 'paused' || this.closed) return;
      started = performance.now();
      handle = setTimeout(() => { cancel(); callback(); }, remaining);
      handle.unref();
    };
    const unsubscribe = this.subscribe(update);
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (handle) clearTimeout(handle);
      handle = undefined;
      unsubscribe();
      this.timers.delete(cancel);
    };
    this.timers.add(cancel);
    if (this.closed) cancel(); else update();
    return cancel;
  }

  private publish(state: RunState): void {
    if (this.closed || this.current === state) return;
    this.current = state;
    for (const listener of [...this.listeners]) listener(state);
  }

  private openGates(): void {
    if (this.closed) return;
    this.publish('running');
    for (const gate of [...this.gates]) gate.resolve();
  }

  private untilClosed(operation: Promise<void>): Promise<boolean> {
    return Promise.race([operation.then(() => true), this.closedSignal.then(() => false)]);
  }

  private async pauseNative(driver: NativeRunDriver, generation: number): Promise<void> {
    if (this.closed || this.generation !== generation) return;
    if (!await this.untilClosed(Promise.resolve().then(() => {
      if (!this.closed) return driver.pause();
    }))) return;
    while (this.holds && !this.closed && this.generation === generation) await delay(20);
    if (!this.closed && this.generation === generation) this.publish('paused');
  }

  private descendants(processes: Map<number, ProcessInfo>): ProcessInfo[] {
    const selected = new Set<number>();
    const groups = new Set<number>();
    for (const root of this.roots) {
      const child = root.child;
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const info = processes.get(child.pid);
      if (!info || (root.identity && !same(root.identity, info))) continue;
      root.identity ??= info;
      selected.add(info.pid);
      if (info.group === info.pid) groups.add(info.group);
    }
    for (const identity of this.frozen.values()) {
      const info = processes.get(identity.pid);
      if (info && same(identity, info)) selected.add(info.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of processes.values()) {
        if (info.pid === process.pid || selected.has(info.pid)) continue;
        if (selected.has(info.parent) || groups.has(info.group)) {
          selected.add(info.pid);
          changed = true;
        }
      }
    }
    return [...selected].map(pid => processes.get(pid)!).filter(Boolean);
  }

  private async freeze(generation: number): Promise<void> {
    let previous = '';
    let freezingSince = 0;
    while (!this.closed && this.generation === generation) {
      if (this.holds) {
        this.thaw();
        previous = '';
        freezingSince = 0;
        await delay(20);
        continue;
      }
      const processes = await snapshot();
      if (this.closed || this.generation !== generation) return;
      const descendants = this.descendants(processes);
      if (!descendants.length) throw new Error('当前执行已结束或尚未就绪，无法暂停');
      const remote = await Promise.all(descendants.map(remoteExecution));
      if (this.closed || this.generation !== generation) return;
      if (this.holds || remote.some(Boolean)) {
        this.thaw();
        previous = '';
        freezingSince = 0;
        await delay(100);
        continue;
      }
      freezingSince ||= Date.now();
      if (Date.now() - freezingSince > 5000) throw new Error('无法确认所有执行进程已暂停');
      const signature = descendants.map(info => `${info.pid}:${info.start}`).sort().join(',');
      if (signature === previous && descendants.every(stopped)) {
        this.publish('paused');
        return;
      }
      previous = signature;
      // Freeze ancestors first, then rescan until no newly spawned descendants remain.
      const roots = new Set([...this.roots].map(root => root.child.pid));
      descendants.sort((first, second) => Number(roots.has(second.pid)) - Number(roots.has(first.pid)));
      for (const info of descendants) {
        if (this.closed || this.generation !== generation) return;
        if (signalProcess(info, 'SIGSTOP')) this.frozen.set(info.pid, info);
      }
      await delay(20);
    }
  }

  private thaw(): void {
    let failure: unknown;
    for (const [pid, identity] of this.frozen) {
      try { signalProcess(identity, 'SIGCONT'); this.frozen.delete(pid); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
