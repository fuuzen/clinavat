import { randomInt, randomUUID } from 'node:crypto';
import { projectFor, sessionFor, type Context } from '../context.js';
import { HttpError, type Session, type User } from '../models.js';
import type { AgentEngine } from '../agent/engines.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { childDirectory, createChild } from './children.js';
import {
  aggregateRanking, agreed, critiquePrompt, debatePrompt, openingPrompt, parseRanking, recordMessage,
  type Contribution, type DiscussionFormat, type DiscussionRecord,
} from './discussion-prompts.js';
import type { ReportDelivery } from './reports.js';
import type { AgentTask, AgentTasks } from './tasks.js';
import { toolInputs } from './tools.js';

export interface ParticipantInput { name: string; engine: AgentEngine; model?: string; effort?: string; slot?: string; stance?: string }
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

/**
 * Runs discussions among read-only child agents. The Hub assembles every round's prompts, so participants never have
 * to agree on turn-taking among themselves, and the host receives the whole record at the end.
 */
export class Discussions {
  private running = new Map<string, AbortController>();

  constructor(private readonly context: Context, private readonly tasks: AgentTasks, private readonly reports: ReportDelivery,
    private readonly agents: ChildAgents) {}

  async start(user: User, host: Session, input: DiscussionInput, startedBy: 'master' | 'user'): Promise<{ id: string; participants: Session[] }> {
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
    try {
      for (const participant of input.participants) {
        const child = await createChild(this.context, user, host, toolInputs.start_agent.parse({
          name: `d${number}-${participant.name}`.slice(0, 32), engine: participant.engine, model: participant.model, effort: participant.effort,
          slot: participant.slot, access: 'read', prompt: input.topic, notify: false,
        }), { project, directory, isolation: 'shared' });
        store.run('UPDATE sessions SET discussion_id=?,discussion_stance=? WHERE id=?', id, participant.stance?.trim() || null, child.id);
        participants.push(sessionFor(this.context, child.id, user.id));
      }
    } catch (error) {
      // They never ran, so nothing of theirs is worth keeping.
      for (const participant of participants) store.run('DELETE FROM sessions WHERE id=?', participant.id);
      this.finish(id, 'error', `参与者未能创建：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    void this.run(user, host, id, controller.signal).finally(() => this.running.delete(id));
    this.agents.publish(host.id);
    return { id, participants };
  }

  /** Stops the discussion and its participants; the host receives no record. */
  async stop(user: User, id: string): Promise<void> {
    const discussion = this.row(id);
    sessionFor(this.context, discussion.host_session_id, user.id);
    if (discussion.status !== 'running') throw new HttpError(409, '讨论已结束');
    const controller = this.running.get(id);
    if (!controller) { this.finish(id, 'stopped', '讨论已停止'); return; }
    controller.abort();
    for (const participant of this.participants(id)) {
      if (this.tasks.running(participant.id).length) await this.agents.stopChild(user, participant).catch(() => undefined);
    }
  }

  private async run(user: User, host: Session, id: string, signal: AbortSignal): Promise<void> {
    const discussion = this.row(id);
    const participants = this.participants(id);
    const record: DiscussionRecord = { id, format: discussion.format, topic: discussion.topic, status: 'running', detail: null, rounds: [] };
    try {
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
      record.status = 'completed';
    } catch (error) {
      record.status = signal.aborted ? 'stopped' : 'error';
      record.detail = signal.aborted ? '讨论已停止' : error instanceof Error ? error.message : String(error);
    }
    this.finish(id, record.status as DiscussionRow['status'], record.detail);
    if (record.status === 'stopped') return;
    try {
      await sendSessionMessage(this.context, user, host.id, messageInput.parse({ content: recordMessage(record), mode: 'queue' }),
        { source: 'report', prompt: content => content });
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

  private finish(id: string, status: DiscussionRow['status'], detail: string | null): void {
    this.context.store.run("UPDATE discussions SET status=?,detail=?,finished_at=datetime('now') WHERE id=?", status, detail, id);
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
