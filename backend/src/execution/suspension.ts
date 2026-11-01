import type { ChildProcess } from 'node:child_process';

/** Pauses a process tree that the Hub cannot reach through its own /proc. */
export interface ProcessSuspender {
  /** Returns false while remote work is in flight; the caller retries. */
  freeze(): Promise<boolean>;
  thaw(): Promise<void>;
}

const suspenders = new WeakMap<ChildProcess, ProcessSuspender>();

export function delegateSuspension(child: ChildProcess, suspender: ProcessSuspender): void {
  suspenders.set(child, suspender);
}

export function suspenderOf(child: ChildProcess): ProcessSuspender | undefined {
  return suspenders.get(child);
}
