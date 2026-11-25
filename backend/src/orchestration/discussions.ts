import { randomInt, randomUUID } from 'node:crypto';
import { projectFor, sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError, type Session, type User } from '../models.js';
import { agentEngines } from '../agent/engines.js';
import type { AgentEngine } from '../agent/engines.js';
import { orchestrationModeOf } from '../agent/orchestration-tools.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { setSessionArchived } from '../routes/sessions.js';
import { childDirectory, createChild, engineSlots } from './children.js';
import {
  aggregateRanking, agreed, compactRecordMessage, critiquePrompt, debatePrompt, openingPrompt, parseRanking, recordMessage,
  type Contribution, type DiscussionFormat, type DiscussionRecord,
} from './discussion-prompts.js';
import { orchestrationConstants } from './limits.js';
import type { ReportDelivery } from './reports.js';
import type { AgentRoster } from './roster.js';
import type { AgentTask, AgentTasks } from './tasks.js';
import { toolInputs } from './tools.js';

export interface ParticipantInput { name: string; profile?: string; engine?: AgentEngine; model?: string; effort?: string; slot?: string; stance?: string }
export interface DiscussionInput { topic: string; format: DiscussionFormat; participants: ParticipantInput[]; rounds?: number; directory?: string }

/** What the engine needs from the orchestrator: sending a task, stopping a child, and telling the panel. */
interface ChildAgents {
  dispatch(user: User, host: Session, child: Session, text: string, mode: 'queue', notify: boolean): Promise<{ task: AgentTask }>;
  stopChild(user: User, child: Session): Promise<void>;
  publish(hostId: string): void;
}

interface DiscussionRow {
  id: string; host_session_id: string; topic: string; format: DiscussionFormat; rounds: number; round: number;
  started_by: 'master' | 'user'; status: 'running' | 'completed' | 'stopped' | 'error'; detail: string | null; created_at: string; finished_at: string | null;
}

/** How long a round waits for its slowest participant; after that it goes on without that statement. */
const roundTimeoutMs = 30 * 60_000;
const activeSessionStatuses = new Set(['running', 'waiting', 'pausing', 'paused']);
const archiveRetryDelaysMs = [200, 400, 800];

/**
 * Runs discussions among read-only child agents. The Hub assembles every round's prompts, so participants never have
 * to agree on turn-taking among themselves, and the host receives the whole record at the end.
 */
export class Discussions {
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private finalizing = new Map<string, Promise<void>>();

  constructor(private readonly context: Context, private readonly tasks: AgentTasks, private readonly reports: ReportDelivery,
    private readonly agents: ChildAgents, private readonly roster: AgentRoster) {}

  async start(user: User, host: Session, input: DiscussionInput, startedBy: 'master' | 'user'): Promise<{ id: string; participants: Session[] }> {
    if (this.context.maintenance.isEnabled()) {
      throw new HttpError(503, `系统正在维护中，暂不支持发起新的多智能体讨论：${this.context.maintenance.blockMessage()}`);
    }
    const { store } = this.context;
    const limits = this.context.orchestrationSettings.view();
    if (input.participants.length > limits.discussionParticipants) throw new HttpError(409, `每场讨论最多 ${limits.discussionParticipants} 位参与者`);
    if (input.format !== 'review' && input.participants.length < 2) throw new HttpError(400, 'council 和 debate 至少需要 2 位参与者');
    if (!input.participants.length) throw new HttpError(400, '请至少添加 1 位参与者');
    if (new Set(input.participants.map(participant => participant.name)).size !== input.participants.length) throw new HttpError(400, '参与者的名字不能重复');
    if (store.get("SELECT id FROM discussions WHERE host_session_id=? AND status='running'", host.id)) throw new HttpError(409, '本对话已有一场进行中的讨论');
    const busy = this.tasks.busyChildren({ userId: user.id }).length;
    if (busy + input.participants.length > limits.runningPerUser) {
      throw new HttpError(409, `你已有 ${busy} 个子智能体在运行，再加 ${input.participants.length} 位参与者会超过上限 ${limits.runningPerUser}`);
    }
    const rounds = input.format === 'council' ? 2 : input.format === 'review' ? 1 : Math.min(input.rounds ?? limits.debateRounds, limits.debateRounds);
    const project = projectFor(this.context, host.project_id, user.id);
    const directory = await childDirectory(project, input.directory);
    const id = randomUUID();
    const number = store.get<{ count: number }>('SELECT COUNT(*) AS count FROM discussions WHERE host_session_id=?', host.id)!.count + 1;
    store.run('INSERT INTO discussions(id,host_session_id,topic,format,rounds,started_by) VALUES(?,?,?,?,?,?)', id, host.id, input.topic, input.format, rounds, startedBy);
    const participants: Session[] = [];
    const usableEngines = agentEngines.filter(engine => engineSlots(this.context, user.id, engine).some(entry => entry.usable));
    const availableEngines = usableEngines.length ? usableEngines : agentEngines.filter(engine => engineSlots(this.context, user.id, engine).length > 0);
    try {
      for (const participant of input.participants) {
        // Participants only speak, so a roster profile lends its CLI, account, model and role but never write access.
        const request = this.roster.resolve(host, toolInputs.start_agent.parse({
          name: `d${number}-${participant.name}`.slice(0, 32), profile: participant.profile, engine: participant.engine, model: participant.model,
          effort: participant.effort, slot: participant.slot, prompt: input.topic, notify: false,
        }), availableEngines);
        const child = await createChild(this.context, user, host, { ...request, access: 'read' }, { project, directory, isolation: 'shared' });
        store.run('UPDATE sessions SET discussion_id=?,discussion_stance=? WHERE id=?', id, participant.stance?.trim() || null, child.id);
        participants.push(sessionFor(this.context, child.id, user.id));
      }
    } catch (error) {
      // They never ran, so nothing of theirs is worth keeping.
      for (const participant of participants) store.run('DELETE FROM sessions WHERE id=?', participant.id);
      await this.finalize(user, id, 'error', `参与者未能创建：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const controller = new AbortController();
    const done = this.run(user, host, id, controller.signal).finally(() => this.running.delete(id));
    this.running.set(id, { controller, done });
    this.agents.publish(host.id);
    return { id, participants };
  }

  /** Stops the discussion and its participants; the host receives no record. */
  async stop(user: User, id: string): Promise<void> {
    const discussion = this.row(id);
    sessionFor(this.context, discussion.host_session_id, user.id);
    if (discussion.status !== 'running') throw new HttpError(409, '讨论已结束');
    const active = this.running.get(id);
    if (!active) {
      await this.finalize(user, id, 'stopped', '讨论已停止');
      return;
    }
    active.controller.abort();
    await active.done;
  }

  private async run(user: User, host: Session, id: string, signal: AbortSignal): Promise<void> {
    let record: DiscussionRecord | undefined;
    try {
      const discussion = this.row(id);
      const participants = this.participants(id);
      record = { id, format: discussion.format, topic: discussion.topic, status: 'running', detail: null, rounds: [] };
      let current = await this.round(user, host, id, 1, participants.map(participant =>
        [participant, openingPrompt(discussion.format, discussion.topic, participant.discussion_stance)]), signal);
      record.rounds.push({ round: 1, contributions: current });
      if (discussion.format === 'council') {
        const answered = current.filter(item => item.status === 'completed');
        if (answered.length < 2) throw new Error('作答的参与者不足 2 位，无法互评');
        // Letters follow a random order, so a letter says nothing about who answered.
        const shuffled = answered.map(item => ({ item, key: randomInt(1 << 30) })).sort((left, right) => left.key - right.key).map(entry => entry.item);
        const letters = shuffled.map((item, index) => ({ label: String.fromCharCode(65 + index), item }));
        record.labels = Object.fromEntries(letters.map(({ label, item }) => [label, item.name]));
        const critiques = await this.round(user, host, id, 2, participants.filter(participant => answered.some(item => item.sessionId === participant.id))
          .map(participant => [participant, critiquePrompt(discussion.topic, letters.filter(({ item }) => item.sessionId !== participant.id)
            .map(({ label, item }) => ({ label, text: item.text })))]), signal);
        record.rounds.push({ round: 2, contributions: critiques });
        const rankings = critiques.map(item => {
          const own = letters.find(letter => letter.item.sessionId === item.sessionId)?.label;
          return parseRanking(item.text, letters.map(letter => letter.label).filter(label => label !== own));
        }).filter((ranking): ranking is string[] => !!ranking?.length);
        record.ranking = aggregateRanking(rankings, letters.map(letter => letter.label));
      }
      if (discussion.format === 'debate') {
        for (let round = 2; round <= discussion.rounds; round++) {
          const previous = current;
          current = await this.round(user, host, id, round, participants.map(participant =>
            [participant, debatePrompt(discussion.topic, round, participant.discussion_stance, previous)]), signal);
          record.rounds.push({ round, contributions: current });
          if (current.length && current.every(item => item.status === 'completed' && agreed(item.text))) break;
        }
      }
      if (signal.aborted) throw new Error('讨论已停止');
      record.status = 'completed';
    } catch (error) {
      const status = signal.aborted ? 'stopped' : 'error';
      const detail = signal.aborted ? '讨论已停止' : error instanceof Error ? error.message : String(error);
      if (!record) {
        await this.finalize(user, id, status, detail);
        return;
      }
      record.status = status;
      record.detail = detail;
    }
    await this.finalize(user, id, record.status as DiscussionRow['status'], record.detail);
    if (record.status === 'stopped') return;
    const currentHost = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=?', host.id) ?? host;
    const hostMode = orchestrationModeOf(currentHost);
    const fullRecord = recordMessage(record, orchestrationConstants.discussionRecordCharacters, hostMode !== 'off');
    const promptRecord = hostMode === 'super' ? compactRecordMessage(record)
      : recordMessage(record, orchestrationConstants.discussionHostCharacters, hostMode !== 'off');
    try {
      await sendSessionMessage(this.context, user, host.id, messageInput.parse({ content: fullRecord, mode: 'queue' }),
        { source: 'report', prompt: () => promptRecord });
    } catch (error) {
      this.context.events.emit(user.id, { type: 'error', sessionId: host.id,
        payload: { message: `讨论记录未能送达：${error instanceof Error ? error.message : String(error)}` } });
    }
  }

  /** Sends each participant its prompt and waits for all of them; a participant that fails only loses its statement. */
  private async round(user: User, host: Session, id: string, round: number, prompts: [Session, string][], signal: AbortSignal) {
    this.context.store.run('UPDATE discussions SET round=? WHERE id=?', round, id);
    this.agents.publish(host.id);
    const sent: { participant: Session; task?: AgentTask; error?: string }[] = [];
    for (const [participant, prompt] of prompts) {
      if (signal.aborted) break;
      try { sent.push({ participant, task: (await this.agents.dispatch(user, host, participant, prompt, 'queue', false)).task }); }
      catch (error) { sent.push({ participant, error: error instanceof Error ? error.message : String(error) }); }
    }
    await this.reports.wait(sent.filter(entry => entry.task).map(entry => entry.participant.id), roundTimeoutMs, signal);
    if (signal.aborted) throw new Error('讨论已停止');
    const finished = sent.map(entry => ({ ...entry, row: entry.task && this.context.store.get<AgentTask>('SELECT * FROM agent_tasks WHERE id=?', entry.task.id) }));
    // Statements reach the host in the record, never as reports of their own.
    this.tasks.delivered(finished.flatMap(entry => entry.row ? [entry.row.id] : []));
    const contributions: (Contribution & { sessionId: string })[] = finished.map(({ participant, row, error }) => ({
      sessionId: participant.id, name: participant.agent_name ?? participant.id, engine: participant.engine, model: participant.model,
      stance: participant.discussion_stance,
      status: error ? 'error' : row?.status === 'running' ? 'timeout' : row?.status ?? 'error',
      text: error ? `任务未能发送：${error}` : row?.status === 'running' ? '本轮超时，没有发言。' : row?.report ?? '',
    }));
    for (const item of contributions) {
      this.context.store.run(`INSERT INTO discussion_statements(discussion_id,session_id,round,status,content) VALUES(?,?,?,?,?)
        ON CONFLICT(discussion_id,session_id,round) DO UPDATE SET status=excluded.status,content=excluded.content`, id, item.sessionId, round, item.status, item.text);
    }
    this.agents.publish(host.id);
    return contributions;
  }

  private finalize(user: User, id: string, status: DiscussionRow['status'], detail: string | null): Promise<void> {
    const active = this.finalizing.get(id);
    if (active) return active;
    const task = this.finalizeNow(user, id, status, detail).finally(() => this.finalizing.delete(id));
    this.finalizing.set(id, task);
    return task;
  }

  private async finalizeNow(user: User, id: string, status: DiscussionRow['status'], detail: string | null): Promise<void> {
    this.finish(id, status, detail);
    const discussion = this.context.store.get<DiscussionRow>('SELECT * FROM discussions WHERE id=?', id);
    if (!discussion) return;
    const participants = this.participants(id);
    if (participants.length) {
      await Promise.allSettled(participants.map(participant => this.cleanupParticipant(user, discussion.host_session_id, participant.id)));
      this.agents.publish(discussion.host_session_id);
    }
  }

  /** Idempotently stops any still-running participant and archives its conversation without ever failing the discussion lifecycle. */
  private async cleanupParticipant(user: User, hostId: string, participantId: string): Promise<void> {
    try {
      for (let attempt = 0; attempt <= archiveRetryDelaysMs.length; attempt++) {
        const current = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=? AND user_id=?', participantId, user.id);
        if (!current) return;
        const stillRunning = this.tasks.running(current.id).length > 0
          || this.context.agents.isBusy(current.id)
          || activeSessionStatuses.has(current.status);
        if (stillRunning) {
          await this.agents.stopChild(user, current).catch(() => undefined);
        }
        const pendingIds = this.tasks.pending(hostId, [current.id]).map(task => task.id);
        if (pendingIds.length) this.tasks.delivered(pendingIds);
        const fresh = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=? AND user_id=?', participantId, user.id);
        if (!fresh || fresh.archived_at) return;
        try {
          await withResourceLocks(this.context, [`session:${fresh.id}`], () =>
            setSessionArchived(this.context, user.id, fresh.id, true));
          return;
        } catch (error) {
          // A turn that just finished may still be releasing its session lock or credential lease for a moment.
          const retryable = error instanceof HttpError && error.statusCode === 409 && attempt < archiveRetryDelaysMs.length;
          if (!retryable) return;
          await new Promise<void>(resolve => setTimeout(resolve, archiveRetryDelaysMs[attempt]).unref());
        }
      }
    } catch {
      // Never allow cleanup errors to disrupt discussion completion or record delivery.
    }
  }

  private finish(id: string, status: DiscussionRow['status'], detail: string | null): void {
    this.context.store.run(
      "UPDATE discussions SET status=?,detail=?,finished_at=COALESCE(finished_at,datetime('now')) WHERE id=? AND status='running'",
      status, detail, id,
    );
    const discussion = this.context.store.get<DiscussionRow>('SELECT * FROM discussions WHERE id=?', id);
    if (discussion) this.agents.publish(discussion.host_session_id);
  }

  private row(id: string): DiscussionRow {
    const discussion = this.context.store.get<DiscussionRow>('SELECT * FROM discussions WHERE id=?', id);
    if (!discussion) throw new HttpError(404, '讨论不存在');
    return discussion;
  }

  private participants(id: string): Session[] {
    return this.context.store.all<Session>('SELECT * FROM sessions WHERE discussion_id=? ORDER BY created_at,rowid', id);
  }

  /** Full statements of a discussion hosted by this master, optionally filtered by round or participant. */
  read(hostId: string, reference: string, round?: number, participant?: string) {
    const discussion = reference.trim().toLowerCase() === 'latest'
      ? this.context.store.get<DiscussionRow>('SELECT * FROM discussions WHERE host_session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', hostId)
      : this.context.store.get<DiscussionRow>('SELECT * FROM discussions WHERE id=? AND host_session_id=?', reference.trim(), hostId);
    if (!discussion) throw new HttpError(404, `本对话没有找到讨论 ${reference}`);
    const members = new Map(this.participants(discussion.id).map(member => [member.id, member]));
    const filterName = participant?.trim().toLowerCase();
    const statements = this.context.store.all<{ session_id: string; round: number; status: string; content: string }>(
      `SELECT session_id,round,status,content FROM discussion_statements WHERE discussion_id=?${round ? ' AND round=?' : ''} ORDER BY round,rowid`,
      ...(round ? [discussion.id, round] : [discussion.id]),
    ).filter(entry => {
      if (!filterName) return true;
      const name = (members.get(entry.session_id)?.agent_name ?? '').toLowerCase();
      return name === filterName || name.replace(/^d\d+-/, '') === filterName;
    });
    return {
      id: discussion.id, topic: discussion.topic, format: discussion.format, status: discussion.status,
      round: discussion.round, rounds: discussion.rounds, detail: discussion.detail,
      statements: statements.map(entry => {
        const member = members.get(entry.session_id);
        return {
          round: entry.round, participant: member?.agent_name ?? entry.session_id,
          engine: member?.engine ?? 'unknown', model: member?.model ?? 'default',
          stance: member?.discussion_stance ?? null, status: entry.status, text: entry.content,
        };
      }),
    };
  }

  /** The host's latest discussions for its agent panel. */
  view(hostId: string) {
    return this.context.store.all<DiscussionRow>('SELECT * FROM discussions WHERE host_session_id=? ORDER BY created_at DESC LIMIT 5', hostId)
      .map(discussion => ({
        id: discussion.id, topic: discussion.topic, format: discussion.format, status: discussion.status, detail: discussion.detail,
        round: discussion.round, rounds: discussion.rounds, startedBy: discussion.started_by,
        participants: this.participants(discussion.id).map(participant => ({
          sessionId: participant.id, name: participant.agent_name ?? participant.title, engine: participant.engine, model: participant.model,
          stance: participant.discussion_stance, running: this.tasks.running(participant.id).length > 0,
          statements: this.context.store.all<{ round: number; status: string }>(
            'SELECT round,status FROM discussion_statements WHERE discussion_id=? AND session_id=? ORDER BY round', discussion.id, participant.id),
        })),
      }));
  }
}
