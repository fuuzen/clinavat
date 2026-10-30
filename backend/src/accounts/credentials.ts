import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Store } from '../database.js';
import { HttpError } from '../models.js';
import { credentialHash, privateDirectory, readAccountCredential, readPrivateJson, writePrivateJson } from './credential-files.js';
import { accountIdentifier, type AccountEngine } from './paths.js';
import { assertSlotSessionState, bindSlotSessionState, detachSlotSessionState } from './session-state/index.js';
import { initializeSlotProfile, restoreSlotProfile, saveSlotProfile } from './slot-runtime/profile.js';
import { assertSlotProcessesStopped } from './slot-runtime/processes.js';

interface CredentialContext {
  user: { id: string }; runtime_home: string; runtime_kind?: 'conversation' | 'probe';
  project?: { id: string };
  slot: { id: string; home_dir: string; engine: AccountEngine; credential_revision: number };
  session: { id: string; engine: AccountEngine };
}
interface SlotJournal {
  version: 3; userId: string; slotId: string; engine: AccountEngine; revision: number;
  home: string; phase: 'preparing' | 'active' | 'releasing';
}
interface SlotLease {
  journal: SlotJournal; count: number; ready: Promise<void>; finishing?: Promise<void>; failure?: Error;
}
interface SessionLease { slotId: string; userId: string; count: number }
interface LeaseRelease {
  lease: SlotLease; sessionId: string; projectId?: string;
  counted: boolean; released: boolean; pending?: Promise<void>;
}
interface CurrentSlot { home_dir: string; engine: AccountEngine; credential_revision: number; status: string }

export class AccountCredentials {
  private leases = new Map<string, SlotLease>();
  private sessions = new Map<string, SessionLease>();
  private projects = new Map<string, number>();
  private userPreparations = new Map<string, Promise<void>>();
  private pauses = new Map<string, Promise<void>>();
  private failedReleases = new Set<LeaseRelease>();

  constructor(private dataDir: string, private store: Store, private onSlotActivity?: (slotId: string) => void) {}

  isUserBusy(userId: string): boolean { return [...this.leases.values()].some(lease => lease.journal.userId === userId); }
  isSlotBusy(slotId: string): boolean { return this.leases.has(slotId); }
  isSessionBusy(sessionId: string): boolean { return this.sessions.has(sessionId); }
  isProjectBusy(projectId: string): boolean { return this.projects.has(projectId); }
  activeUserId(slotId: string): string | null { return this.leases.get(slotId)?.journal.userId ?? null; }

  // Call only after the session's run has ended; active leases never enter this retry set.
  async retrySessionRelease(sessionId: string): Promise<void> {
    for (const release of this.failedReleases) {
      if (release.sessionId !== sessionId) continue;
      try { await this.release(release); }
      catch (error) {
        throw new HttpError(409, `会话状态回收尚未完成：${error instanceof Error ? error.message : '请稍后重试'}`);
      }
    }
  }

  async fingerprint(context: CredentialContext): Promise<string | null> {
    const journal = this.journalFor(context);
    this.currentSlot(journal, true);
    const lease = this.leases.get(journal.slotId);
    if (lease) { await lease.ready; this.assertHealthy(lease); }
    return credentialHash(await readAccountCredential(journal.home, journal.engine));
  }

  // Runs a short task while no lease exists; new leases wait for it. Returns undefined when the slot is in use.
  async whileIdle<T>(slotId: string, task: () => Promise<T>): Promise<{ value: T } | undefined> {
    if (this.leases.has(slotId) || this.pauses.has(slotId)) return undefined;
    let resume!: () => void;
    this.pauses.set(slotId, new Promise<void>(resolve => { resume = resolve; }));
    try { return { value: await task() }; }
    finally { this.pauses.delete(slotId); resume(); }
  }

  async acquire(context: CredentialContext): Promise<() => Promise<void>> {
    for (let pause = this.pauses.get(context.slot.id); pause; pause = this.pauses.get(context.slot.id)) await pause;
    const journal = this.journalFor(context);
    const current = this.currentSlot(journal, true);
    if (current.status !== 'IDLE') throw new HttpError(409, '该授权槽位当前不可用');
    let lease = this.leases.get(journal.slotId);
    if (lease) {
      this.assertHealthy(lease);
      if (lease.journal.userId !== journal.userId) throw new HttpError(409, '该授权槽位正由其他用户使用，请稍后重试或切换槽位');
      if (lease.finishing) { await lease.finishing; return this.acquire(context); }
    }
    const sessionId = context.runtime_kind === 'probe' ? '' : context.session.id;
    if (sessionId) {
      accountIdentifier(sessionId);
      const previous = this.sessions.get(sessionId);
      if (previous && (previous.slotId !== journal.slotId || previous.userId !== journal.userId)) {
        throw new HttpError(409, '该对话的原槽位进程尚未退出，请等待后切换');
      }
      this.sessions.set(sessionId, { slotId: journal.slotId, userId: journal.userId, count: (previous?.count ?? 0) + 1 });
    }
    if (!lease) {
      lease = { journal, count: 0, ready: Promise.resolve() };
      // Reserve before filesystem awaits so another user cannot enter during preparation.
      this.leases.set(journal.slotId, lease);
      lease.ready = this.prepare(journal);
      this.onSlotActivity?.(journal.slotId);
    }
    const active = lease;
    const projectId = context.project?.id;
    if (projectId) this.projects.set(projectId, (this.projects.get(projectId) ?? 0) + 1);
    active.count += 1;
    const release: LeaseRelease = { lease: active, sessionId, projectId, counted: true, released: false };
    try {
      await active.ready;
      this.assertHealthy(active);
      await assertSlotSessionState(this.dataDir, journal.userId, journal.home, journal.engine);
    }
    catch (error) {
      try { await this.release(release); } catch { /* Preserve failed state for recovery. */ }
      throw error;
    }
    return () => this.release(release);
  }

  async recover(): Promise<void> {
    const directory = join(this.dataDir, 'accounts', 'slot-runtime');
    await privateDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error('槽位运行恢复日志类型无效');
      const slotId = accountIdentifier(entry.name.slice(0, -5));
      const content = await readPrivateJson(this.file(slotId));
      if (!content) continue;
      const journal = JSON.parse(content) as SlotJournal;
      this.validateJournal(journal);
      if (journal.slotId !== slotId) throw new Error('槽位运行恢复日志归属无效');
      await this.settle(journal);
    }
  }

  private release(release: LeaseRelease): Promise<void> {
    if (release.released) return Promise.resolve();
    if (release.pending) return release.pending;
    const { lease } = release;
    const pending = this.releaseLease(release).then(() => {
      release.released = true;
      this.failedReleases.delete(release);
      if (![...this.failedReleases].some(other => other.lease === lease)) lease.failure = undefined;
      this.onSlotActivity?.(lease.journal.slotId);
    }).catch((error: unknown) => {
      lease.failure = error instanceof Error ? error : new Error('槽位用户状态回收失败');
      this.failedReleases.add(release);
      this.onSlotActivity?.(lease.journal.slotId);
      throw lease.failure;
    }).finally(() => { release.pending = undefined; });
    release.pending = pending;
    return pending;
  }

  private async releaseLease(release: LeaseRelease): Promise<void> {
    const { lease, sessionId, projectId } = release;
    if (release.counted) {
      if (sessionId && this.sessions.get(sessionId)?.count === 1) await assertSlotProcessesStopped(lease.journal.home, sessionId);
      // Final profile recovery can fail after this decrement; retries must not subtract twice.
      lease.count -= 1;
      release.counted = false;
    }
    if (!lease.count) {
      lease.finishing ??= this.settle(lease.journal).then(() => {
        if (this.leases.get(lease.journal.slotId) === lease) this.leases.delete(lease.journal.slotId);
      }).catch((error: unknown) => { lease.finishing = undefined; throw error; });
      await lease.finishing;
    }
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session && --session.count === 0) this.sessions.delete(sessionId);
    }
    if (projectId) {
      const count = (this.projects.get(projectId) ?? 1) - 1;
      if (count) this.projects.set(projectId, count); else this.projects.delete(projectId);
    }
  }

  private assertHealthy(lease: SlotLease): void {
    if (lease.failure) throw new HttpError(409, '槽位的用户状态回收尚未完成，请联系管理员检查运行恢复日志');
  }

  private file(slotId: string): string { return join(this.dataDir, 'accounts', 'slot-runtime', `${accountIdentifier(slotId)}.json`); }

  private journalFor(context: CredentialContext): SlotJournal {
    accountIdentifier(context.user.id);
    accountIdentifier(context.slot.id);
    if (context.slot.engine !== context.session.engine) throw new HttpError(409, '授权槽位与对话引擎不匹配');
    if (context.runtime_home !== context.slot.home_dir) throw new Error('CLI 必须使用槽位的固定运行目录');
    const journal: SlotJournal = { version: 3, userId: context.user.id, slotId: context.slot.id,
      engine: context.session.engine, revision: context.slot.credential_revision, home: context.slot.home_dir, phase: 'preparing' };
    this.validateJournal(journal);
    return journal;
  }

  private validateJournal(journal: SlotJournal): void {
    accountIdentifier(journal.userId);
    accountIdentifier(journal.slotId);
    if (journal.version !== 3 || !['claude', 'codex'].includes(journal.engine)
      || !Number.isSafeInteger(journal.revision) || journal.revision < 0
      || !['preparing', 'active', 'releasing'].includes(journal.phase)
      || journal.home !== resolve(this.dataDir, 'slots', journal.slotId)) throw new Error('槽位运行恢复日志无效');
  }

  private currentSlot(journal: SlotJournal, requireAccess = false): CurrentSlot {
    const slot = this.store.get<CurrentSlot>('SELECT home_dir,engine,credential_revision,status FROM account_slots WHERE id=?', journal.slotId);
    if (!slot || slot.home_dir !== journal.home || slot.engine !== journal.engine || slot.credential_revision !== journal.revision) {
      throw new HttpError(409, '槽位配置发生变化，已保留用户状态，请刷新或检查恢复日志');
    }
    if (requireAccess && !this.store.get('SELECT 1 FROM slot_user_access WHERE slot_id=? AND user_id=?', journal.slotId, journal.userId)) {
      throw new HttpError(403, '无权使用该授权槽位');
    }
    return slot;
  }

  private async prepare(journal: SlotJournal): Promise<void> {
    this.currentSlot(journal, true);
    await assertSlotProcessesStopped(journal.home);
    if (await readPrivateJson(this.file(journal.slotId))) throw new Error('槽位仍有未处理的运行恢复日志，请先重启 Hub 完成恢复');
    if (await readAccountCredential(journal.home, journal.engine) === undefined) {
      throw new HttpError(409, `授权槽位尚未完成 ${journal.engine} 登录，请联系管理员`);
    }
    await initializeSlotProfile(this.dataDir, journal.slotId, journal.home, journal.engine);
    await writePrivateJson(this.file(journal.slotId), JSON.stringify(journal));
    await restoreSlotProfile(this.dataDir, journal.userId, journal.slotId, journal.home, journal.engine);
    const key = `${journal.userId}:${journal.engine}`;
    const previous = this.userPreparations.get(key) ?? Promise.resolve();
    const preparation = previous.then(() => bindSlotSessionState(this.dataDir, this.store, journal.userId, journal.home, journal.engine));
    const tail = preparation.then(() => undefined, () => undefined);
    this.userPreparations.set(key, tail);
    try { await preparation; }
    finally { if (this.userPreparations.get(key) === tail) this.userPreparations.delete(key); }
    journal.phase = 'active';
    await writePrivateJson(this.file(journal.slotId), JSON.stringify(journal));
  }

  private async settle(journal: SlotJournal): Promise<void> {
    const content = await readPrivateJson(this.file(journal.slotId));
    if (!content) return;
    const saved = JSON.parse(content) as SlotJournal;
    this.validateJournal(saved);
    if (saved.userId !== journal.userId || saved.slotId !== journal.slotId) throw new Error('槽位恢复日志归属发生变化');
    this.currentSlot(saved);
    await assertSlotProcessesStopped(saved.home);
    saved.phase = 'releasing';
    await writePrivateJson(this.file(saved.slotId), JSON.stringify(saved));
    await detachSlotSessionState(saved.home, saved.engine);
    await saveSlotProfile(this.dataDir, saved.userId, saved.slotId, saved.home, saved.engine);
    await rm(this.file(saved.slotId));
  }
}
