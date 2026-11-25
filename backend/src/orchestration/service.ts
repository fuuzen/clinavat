import type { Context } from '../context.js';
import { projectFor, sessionFor, withResourceLocks } from '../context.js';
import { HttpError, type Project, type Session, type User } from '../models.js';
import { agentEngines, type AgentEngine } from '../agent/engines.js';
import { canInspectProject, orchestrationModeOf, orchestrates } from '../agent/orchestration-tools.js';
import type { AgentContext, AgentEvent, HubToolResult, OrchestrationHost } from '../agent/types.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { setSessionArchived, stopSession } from '../routes/sessions.js';
import { WorkBoard, type WorkItemRow } from './board.js';
import { assertChildRoom, assertNewName, childDirectory, createChild, engineSlots, reconfigureChild, type Placement } from './children.js';
import { ProjectInspector } from './inspect.js';
import { delegationPrompt, reportBlock } from './instructions.js';
import { orchestrationConstants } from './limits.js';
import { ProjectMemory } from './memory.js';
import { ReportDelivery, reportSource } from './reports.js';
import { Discussions, type DiscussionInput } from './discussions.js';
import { AgentRoster } from './roster.js';
import { buildEngineSlotSummaries, refreshSlotUsage, type SlotUsageRefreshResult } from './slot-usage.js';
import { AgentTasks } from './tasks.js';
import { hubTools, isToolName, toolInputs, type ToolName } from './tools.js';

const json = (value: unknown): HubToolResult => ({ text: JSON.stringify(value, null, 1) });
const isActive = (status: string) => ['running', 'waiting', 'pausing', 'paused'].includes(status);

/** Serves the clinavat tools of master agents and follows their children for the agent panel. */
export class Orchestrator implements OrchestrationHost {
  private readonly inspector: ProjectInspector;
  private readonly tasks: AgentTasks;
  private readonly reports: ReportDelivery;
  private readonly discussions: Discussions;
  readonly board: WorkBoard;
  readonly memory: ProjectMemory;
  readonly roster: AgentRoster;

  constructor(private readonly context: Context) {
    this.tasks = new AgentTasks(context.store);
    this.board = new WorkBoard(context.store);
    this.inspector = new ProjectInspector(context.workspaces);
    this.memory = new ProjectMemory(context.store);
    this.reports = new ReportDelivery(context, this.tasks, masterId => this.publish(masterId), (user, master, delivered) => {
      for (const childId of new Set(delivered.map(task => task.child_session_id))) {
        void this.retireEphemeralIfSettled(user, master.id, childId);
      }
    });
    this.roster = new AgentRoster(context.store);
    this.discussions = new Discussions(context, this.tasks, this.reports, this, this.roster);
  }

  /** A discussion the user starts from the web, hosted by the moderator conversation created for it. */
  startDiscussion(user: User, host: Session, input: DiscussionInput) { return this.discussions.start(user, host, input, 'user'); }
  stopDiscussion(user: User, id: string) { return this.discussions.stop(user, id); }

  directs(tool: string): boolean { return ['start_agent', 'message_agent', 'merge_agent', 'discard_agent', 'start_discussion'].includes(tool); }

  toolsFor(agent: AgentContext) {
    if (!orchestrates(agent)) return [];
    return canInspectProject(agent.session) ? hubTools : hubTools.filter(tool => tool.name !== 'inspect');
  }

  briefing(agent: AgentContext): string {
    const master = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=? AND user_id=?', agent.session.id, agent.user.id);
    if (!master || orchestrationModeOf(master) === 'off') return '';
    const available = this.availableEngines(master.user_id);
    const engineSummary = agentEngines.map(engine => {
      const slots = engineSlots(this.context, master.user_id, engine);
      if (!slots.length) return null;
      const usable = slots.filter(entry => entry.usable).length;
      return `${engine} (${usable}/${slots.length} usable)`;
    }).filter((entry): entry is string => !!entry);
    const roster = this.roster.effective(master, available);
    const children = this.view(master.id).agents.filter(child => !child.archived);
    const limits = this.context.orchestrationSettings.view();
    const lines = [
      '### Current Orchestration Snapshot',
      `- Engines: ${engineSummary.length ? engineSummary.join(', ') : 'none available'}`,
      `- Limits: up to ${limits.runningPerMaster} running children (${limits.worktreeWritersPerMaster} parallel worktree writers)`,
      '- Profiles (pass via `profile` in `start_agent`):',
      ...roster.map(profile => `  - \`${profile.name}\` [${profile.engine}, ${profile.access}${profile.builtIn ? ', built-in' : ''}]: ${(profile.role ?? 'custom role').replace(/\s+/g, ' ').slice(0, 140)}`),
      ...this.memory.briefingLines(master.project_id),
      ...this.board.briefingLines(master.id),
    ];
    if (children.length) {
      lines.push('- Existing children in this conversation:');
      for (const child of children.slice(-12)) {
        const worktree = child.worktree?.state && child.worktree.state !== 'clean' ? `, worktree:${child.worktree.state}` : '';
        lines.push(`  - \`${child.name}\` [${child.engine}, ${child.access}, ${child.running ? 'running' : child.status}${worktree}]`);
      }
    }
    return lines.join('\n');
  }

  observe(event: AgentEvent): void { this.reports.observe(event); }

  clearInspectCache(id: string): void { this.inspector.clearSession(id); }

  sessionDeleted(id: string, masterId: string | null): void {
    this.clearInspectCache(id);
    this.reports.sessionDeleted(id, masterId);
  }

  async call(agent: AgentContext, tool: string, args: unknown, signal: AbortSignal): Promise<HubToolResult> {
    if (!isToolName(tool)) return { text: `未知的编排工具：${tool}`, isError: true };
    const user = this.context.store.get<User>('SELECT * FROM users WHERE id=?', agent.user.id);
    if (!user) return { text: '用户不存在', isError: true };
    const master = sessionFor(this.context, agent.session.id, user.id);
    if (orchestrationModeOf(master) === 'off') return { text: '当前对话未开启编排', isError: true };
    try {
      if (tool === 'inspect') {
        if (!canInspectProject(master)) throw new HttpError(403, '当前对话未启用 inspect，请委派 explorer 子智能体检视项目。');
        return await this.inspector.inspect(agent, projectFor(this.context, master.project_id, user.id), args, signal);
      }
      return await this.run(tool, user, master, args, signal, agent.session.agent_mode === 'plan');
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private availableEngines(userId: string): AgentEngine[] {
    const usable = agentEngines.filter(engine => engineSlots(this.context, userId, engine).some(entry => entry.usable));
    if (usable.length) return usable;
    return agentEngines.filter(engine => engineSlots(this.context, userId, engine).length > 0);
  }

  private assertNotInMaintenance(action: string): void {
    if (this.context.maintenance.isEnabled()) {
      throw new HttpError(503, `系统正在维护中，暂不支持${action}：${this.context.maintenance.blockMessage()}`);
    }
  }

  private async run(tool: Exclude<ToolName, 'inspect'>, user: User, master: Session, args: unknown, signal: AbortSignal,
    planning: boolean): Promise<HubToolResult> {
    const superAgent = orchestrationModeOf(master) === 'super';
    switch (tool) {
      case 'list_agents': {
        const input = toolInputs.list_agents.parse(args ?? {});
        const refreshResult = input.refreshUsage?.length
          ? await refreshSlotUsage(this.context, user.id, input.refreshUsage, signal)
          : undefined;
        return json(this.list(user, master, refreshResult));
      }
      case 'start_agent': {
        this.assertNotInMaintenance('派生新的子智能体');
        const input = this.roster.resolve(master, toolInputs.start_agent.parse(args), this.availableEngines(user.id));
        if (planning && input.access === 'write') throw new HttpError(409, 'Plan 模式下只能派生只读子智能体');
        assertNewName(this.context, master, input.name);
        const item = input.task ? this.board.resolve(master.id, input.task)
          : superAgent && input.access === 'read' && input.profile === 'verifier' ? this.board.reviewTask(master.id, null) : undefined;
        const main = projectFor(this.context, master.project_id, user.id);
        const directory = await childDirectory(main, input.directory);
        const requested = input.access === 'write' ? input.isolation ?? 'worktree' : 'shared';
        assertChildRoom(this.context, this.tasks, user, master, { access: input.access, isolation: requested, directory });
        const notes: string[] = [];
        let placement: Placement = { project: main, directory, isolation: 'shared' };
        if (requested === 'worktree') {
          const worktree = await this.worktrees.create(main, master, input.name, directory);
          if (worktree) {
            placement = { project: worktree.project, directory: worktree.directory, isolation: 'worktree' };
            notes.push(`The child works on branch ${worktree.project.worktree_branch} in its own worktree; merge it with merge_agent when it reports.`);
            if (worktree.dirty) notes.push('The repository has uncommitted changes to tracked files. The child started from the last commit and does not see them; commit them first if it needs them.');
            if (worktree.setup) notes.push(worktree.setup);
          } else {
            assertChildRoom(this.context, this.tasks, user, master, { access: input.access, isolation: 'shared', directory });
            notes.push('The directory is not in a Git repository with commits, so the child works in the shared project directory.');
          }
        }
        return this.withReview(superAgent, input.access, input.profile, item, async () => {
          const child = await createChild(this.context, user, master, input, placement).catch(async (error: unknown) => {
            if (placement.isolation === 'worktree') await this.removeProject(placement.project);
            throw error;
          });
          if (item) {
            const linked = this.board.assign(master.id, item.id, input.name);
            notes.push(`Linked to task ${linked.code} (${linked.title}).`);
          }
          return this.send(user, master, child, input.prompt, 'queue', input.notify, notes, item, input.wave);
        });
      }
      case 'message_agent': {
        this.assertNotInMaintenance('向子智能体派发新任务');
        const input = toolInputs.message_agent.parse(args);
        const child = this.child(master, input.agent);
        if (planning && child.agent_access === 'write') throw new HttpError(409, 'Plan 模式下不能指挥可写子智能体');
        if (!this.tasks.running(child.id).length) {
          assertChildRoom(this.context, this.tasks, user, master, { access: child.agent_access ?? 'write',
            isolation: child.agent_isolation ?? 'shared', directory: child.agent_directory });
        }
        const item = input.task ? this.board.resolve(master.id, input.task)
          : this.board.resolveActive(master.id, this.tasks.latestWorkItem(child.id))
            ?? (superAgent && child.agent_access === 'read' ? this.board.reviewTask(master.id, child.agent_name)
              ?? (child.agent_profile === 'verifier' ? this.board.reviewTask(master.id, null) : undefined) : undefined);
        return this.withReview(superAgent, child.agent_access, child.agent_profile, item, async () => {
          const { child: active, notes } = await reconfigureChild(this.context, user, this.tasks, child, input);
          return this.send(user, master, active, input.message, input.mode, true, notes, item, input.wave);
        });
      }
      case 'merge_agent': {
        const input = toolInputs.merge_agent.parse(args);
        const child = this.child(master, input.agent);
        const result = await this.merge(child, input.mode, input.onConflict);
        const shouldArchive = result.status === 'merged' && (input.archive ?? child.agent_ephemeral === 1);
        const archived = shouldArchive ? await this.tryArchiveChild(user, master.id, child.id) : false;
        return json({ ...result, ...(archived ? { archived: true } : {}) });
      }
      case 'start_discussion': {
        this.assertNotInMaintenance('发起新的多智能体讨论');
        const input = toolInputs.start_discussion.parse(args);
        const { id, participants } = await this.discussions.start(user, master, input, 'master');
        return json({ discussionId: id, participants: participants.map(participant => participant.agent_name), status: 'running',
          note: 'The record arrives as a new message when the discussion ends. Use read_discussion or read_agent for full statements.' });
      }
      case 'stop_discussion': {
        const { discussion } = toolInputs.stop_discussion.parse(args);
        await this.discussions.stop(user, discussion);
        return json({ discussion, status: 'stopped' });
      }
      case 'read_discussion': {
        const input = toolInputs.read_discussion.parse(args);
        return json(this.discussions.read(master.id, input.discussion, input.round, input.participant));
      }
      case 'memory': {
        const input = toolInputs.memory.parse(args);
        if (input.action === 'list') return json({ memories: this.memory.view(master.project_id) });
        if (!input.key) throw new HttpError(400, `memory(action="${input.action}") 需要指定 key`);
        if (input.action === 'read') return json(this.memory.read(master.project_id, input.key));
        if (input.action === 'delete') {
          const deleted = this.memory.remove(master.project_id, input.key);
          this.publish(master.id);
          return json({ key: input.key, deleted });
        }
        if (!input.content) throw new HttpError(400, 'memory(action="write") 需要提供 content');
        const saved = this.memory.write(master.project_id, input.key, input.content);
        this.publish(master.id);
        return json(saved);
      }
      case 'discard_agent': {
        const input = toolInputs.discard_agent.parse(args);
        const child = this.worktreeChild(this.child(master, input.agent));
        await this.worktrees.discard(child);
        const archived = (input.archive ?? child.agent_ephemeral === 1) ? await this.tryArchiveChild(user, master.id, child.id) : false;
        this.publish(master.id);
        return json({ agent: child.agent_name, status: 'discarded', ...(archived ? { archived: true } : {}) });
      }
      case 'archive_agent': {
        const { agents } = toolInputs.archive_agent.parse(args);
        const archived: string[] = [];
        for (const reference of agents) {
          const child = this.child(master, reference, true);
          if (!child.archived_at) await this.archiveChild(user, master.id, child);
          archived.push(child.agent_name ?? child.id);
        }
        return json({ archived });
      }
      case 'task_board': {
        const input = toolInputs.task_board.parse(args);
        if (input.action === 'archive') this.assertNotInMaintenance('归档看板任务');
        const { result, changed } = this.board.execute(master.id, input);
        if (changed) this.publish(master.id);
        return json(result);
      }
      case 'wait_agents': {
        const input = toolInputs.wait_agents.parse(args);
        const children = input.agents.map(reference => this.child(master, reference));
        const finished = await this.reports.wait(children.map(child => child.id), input.timeoutSeconds * 1000, signal);
        const reports = this.tasks.pending(master.id, children.map(child => child.id));
        this.reports.received(reports);
        for (const childId of new Set(reports.map(task => task.child_session_id))) {
          void this.retireEphemeralIfSettled(user, master.id, childId);
        }
        return json({
          finished,
          reports: reports.map(task => reportBlock(reportSource(children.find(child => child.id === task.child_session_id)!, task), { superAgent })),
          stillRunning: children.filter(child => this.tasks.running(child.id).length).map(child => child.agent_name),
        });
      }
      case 'read_agent': {
        const input = toolInputs.read_agent.parse(args);
        return json(this.tasks.read(this.child(master, input.agent, true), input.turns, input.includeTools, superAgent));
      }
      case 'stop_agent': {
        const child = this.child(master, toolInputs.stop_agent.parse(args).agent);
        await this.stopChild(user, child);
        return json({ agent: child.agent_name, status: 'stopped' });
      }
    }
  }

  private child(master: Session, reference: string, allowArchived = false): Session {
    const child = this.tasks.children(master.id).find(item => item.agent_name === reference || item.id === reference);
    if (!child) throw new HttpError(404, `本对话没有名为 ${reference} 的子智能体，请先用 list_agents 查看`);
    if (child.archived_at && !allowArchived) throw new HttpError(409, `子智能体 ${reference} 的对话已归档（仍可用 read_agent 查看历史回复）`);
    return child;
  }

  private async archiveChild(user: User, masterId: string, child: Session): Promise<void> {
    if (this.tasks.running(child.id).length || isActive(child.status)) {
      throw new HttpError(409, `子智能体 ${child.agent_name} 仍在运行，请等待完成或先停止后再归档`);
    }
    if (this.tasks.pending(masterId, [child.id]).length) {
      throw new HttpError(409, `子智能体 ${child.agent_name} 仍有未送达的汇报，请等待送达后再归档`);
    }
    if (child.agent_isolation === 'worktree') {
      const worktree = this.worktreeView(child);
      if (worktree && worktree.state !== 'clean') {
        throw new HttpError(409, `子智能体 ${child.agent_name} 仍有待处理的 worktree 分支修改（${worktree.state}），请先 merge_agent 或 discard_agent`);
      }
    }
    await withResourceLocks(this.context, [`session:${child.id}`], () => setSessionArchived(this.context, user.id, child.id, true));
  }

  private async tryArchiveChild(user: User, masterId: string, childId: string): Promise<boolean> {
    const fresh = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=? AND user_id=?', childId, user.id);
    if (!fresh || fresh.archived_at) return false;
    return this.archiveChild(user, masterId, fresh).then(() => true, () => false);
  }

  /** Automatically archives an ephemeral non-worktree child shortly after its final report is delivered. */
  private async retireEphemeralIfSettled(user: User, masterId: string, childId: string): Promise<void> {
    const child = this.context.store.get<Session>('SELECT * FROM sessions WHERE id=? AND user_id=?', childId, user.id);
    if (!child || child.archived_at || child.agent_ephemeral !== 1 || child.agent_isolation === 'worktree') return;
    await new Promise<void>(resolve => setTimeout(resolve, 400).unref());
    await this.tryArchiveChild(user, masterId, childId);
  }

  private worktreeChild(child: Session): Session {
    if (child.agent_isolation !== 'worktree') throw new HttpError(409, `子智能体 ${child.agent_name} 没有使用 worktree，它的修改已直接在项目中`);
    if (this.tasks.running(child.id).length || isActive(child.status)) throw new HttpError(409, `子智能体 ${child.agent_name} 仍在运行，请等它完成或先停止`);
    return child;
  }

  async merge(child: Session, mode: 'merge' | 'squash', onConflict: 'abort' | 'leave') {
    const outcome = await this.worktrees.merge(this.worktreeChild(child), mode, onConflict);
    this.publish(child.parent_session_id!);
    return { agent: child.agent_name, ...outcome };
  }

  /** The user hands a merge conflict to the master agent, which receives it as a message and takes a turn. */
  async handoff(user: User, masterId: string, childId: string): Promise<void> {
    const master = sessionFor(this.context, masterId, user.id);
    const child = this.child(master, childId);
    const project = this.worktrees.project(child.project_id);
    if (project.worktree_state !== 'conflict') throw new HttpError(409, '该子智能体没有待处理的合并冲突');
    const files = JSON.parse(project.worktree_conflicts ?? '[]') as string[];
    const resolution = orchestrationModeOf(master) === 'super'
      ? `The user asks you to coordinate resolving them. Ask ${child.agent_name} with message_agent to merge the latest commit of the project into its branch and resolve the conflicts, then call merge_agent again.`
      : 'The user asks you to resolve them. Either call merge_agent with onConflict "leave", resolve the markers, commit, and call discard_agent to clean up; '
        + `or ask ${child.agent_name} with message_agent to merge the latest commit of the project into its branch, then call merge_agent again.`;
    const text = `Merging the branch ${project.worktree_branch} of ${child.agent_name} into the project stopped on conflicts in: ${files.join(', ') || 'unknown files'}. ${resolution}`;
    await sendSessionMessage(this.context, user, master.id, messageInput.parse({ content: reportBlock({ name: child.agent_name ?? child.id,
      engine: child.engine, model: child.model, status: 'conflict', task: '合并冲突', text },
    { superAgent: orchestrationModeOf(master) === 'super' }), mode: 'queue' }), { source: 'report', prompt: content => content });
  }

  async discard(user: User, masterId: string, childId: string): Promise<void> {
    const child = this.worktreeChild(this.child(sessionFor(this.context, masterId, user.id), childId));
    await this.worktrees.discard(child);
    this.publish(masterId);
  }

  /** Removes a worktree project the child could not be created in, and its checkout. */
  private async removeProject(project: Project): Promise<void> {
    await this.worktrees.release(project).catch(() => undefined);
    this.context.store.run('DELETE FROM projects WHERE id=?', project.id);
  }

  private get worktrees() {
    if (!this.context.worktrees) throw new HttpError(503, 'worktree 服务尚未就绪');
    return this.context.worktrees;
  }

  /** Sends a child one task; when the send fails, the task ends at once and the error goes to the caller. */
  async dispatch(user: User, master: Session, child: Session, text: string, mode: 'queue' | 'steer' | 'interrupt',
    notify: boolean, workItemId?: string, wave?: string) {
    const task = this.tasks.create(master.id, child.id, text, notify, workItemId, wave);
    this.publish(master.id);
    try {
      const sent = await sendSessionMessage(this.context, user, child.id, messageInput.parse({ content: text, mode }), {
        source: 'delegation',
        prompt: expanded => delegationPrompt(master, { name: child.agent_name!, access: child.agent_access ?? 'write' }, expanded),
      });
      return { task, status: sent.status };
    } catch (error) {
      this.tasks.discard(task.id, `任务未能发送：${error instanceof Error ? error.message : String(error)}`);
      if (task.wave) this.reports.schedule(master.id);
      this.publish(master.id);
      throw error;
    }
  }

  private async send(user: User, master: Session, child: Session, text: string, mode: 'queue' | 'steer' | 'interrupt', notify: boolean,
    notes: string[], item?: WorkItemRow, wave?: string) {
    // A failed send reaches the master as the tool's error, so its task needs no report.
    const { status } = await this.dispatch(user, master, child, text, mode, notify, item?.id, wave);
    if (child.agent_access === 'write' && child.agent_isolation !== 'worktree') {
      notes.push('This child modifies the shared project directory: do not edit the files it is working on until its report arrives.');
    }
    return json({ agentId: child.agent_name, sessionId: child.id, engine: child.engine, model: child.model ?? 'default', slot: child.slot_id,
      access: child.agent_access, isolation: child.agent_isolation, directory: child.agent_directory ?? '.', status,
      ...(notify ? {} : { notify: false }), ...(notes.length ? { notes } : {}) });
  }

  async stopChild(user: User, child: Session): Promise<void> {
    await stopSession(this.context, user.id, child.id);
    // A child stopped before its process started reports no turn end.
    await this.reports.complete(sessionFor(this.context, child.id, user.id), 'interrupted', '子智能体已被停止。');
  }

  private async withReview(superAgent: boolean, access: Session['agent_access'], profile: string | null | undefined,
    item: WorkItemRow | undefined, dispatch: () => Promise<HubToolResult>): Promise<HubToolResult> {
    const current = superAgent && access === 'read' && item ? this.board.resolve(item.master_session_id, item.id) : undefined;
    const refund = current && (profile === 'verifier' || current.status === 'verifying') ? this.board.beginReview(current) : undefined;
    try { return await dispatch(); }
    catch (error) {
      refund?.();
      if (refund && current) this.publish(current.master_session_id);
      throw error;
    }
  }

  private list(user: User, master: Session, refreshResult?: SlotUsageRefreshResult) {
    const view = this.view(master.id);
    return {
      engines: buildEngineSlotSummaries(this.context, user.id),
      ...(refreshResult ? { refreshResult } : {}),
      // Start one with start_agent's profile; the master may still override any field.
      roster: this.roster.effective(master, this.availableEngines(user.id)),
      children: view.agents.filter(child => !child.archived)
        .map(({ name, engine, slotId, model, access, status, running, ephemeral, worktree }) => ({
          name, engine, slotId, model, access, status, running, ...(ephemeral ? { ephemeral: true } : {}),
          ...(worktree && worktree.state !== 'clean' ? { worktree: worktree.state } : {}),
        })),
      archivedChildren: view.agents.filter(child => child.archived).length,
      ...this.board.list(master.id),
      limits: { ...this.context.orchestrationSettings.view(), waitSeconds: orchestrationConstants.waitSeconds },
    };
  }

  view(masterId: string) {
    const master = this.context.store.get<Pick<Session, 'project_id'>>('SELECT project_id FROM sessions WHERE id=?', masterId);
    const pending = this.tasks.pending(masterId);
    return {
      // Participants of discussions show in their discussion's card.
      agents: this.tasks.children(masterId).filter(child => !child.discussion_id).map(child => {
        const latest = this.tasks.latest(child.id);
        return {
          sessionId: child.id, name: child.agent_name ?? child.title, engine: child.engine, model: child.model, slotId: child.slot_id,
          access: child.agent_access ?? 'write', status: child.status, archived: !!child.archived_at, ephemeral: child.agent_ephemeral === 1,
          running: this.tasks.running(child.id).length > 0, directory: child.agent_directory, isolation: child.agent_isolation ?? 'shared',
          worktree: child.agent_isolation === 'worktree' ? this.worktreeView(child) : null,
          lastTask: latest ? { status: latest.status, finishedAt: latest.finished_at } : null,
          pendingReports: pending.filter(task => task.child_session_id === child.id).length,
        };
      }),
      ...this.board.list(masterId),
      memories: master ? this.memory.view(master.project_id) : [],
      discussions: this.discussions.view(masterId),
      pendingReports: pending.length,
      reportsPaused: pending.length > 0 && this.reports.atQuota(masterId),
    };
  }

  private worktreeView(child: Session) {
    const project = this.context.store.get<Project>('SELECT * FROM projects WHERE id=?', child.project_id);
    if (!project?.parent_project_id) return null;
    return { branch: project.sync_status === 'DORMANT' ? null : project.worktree_branch ?? null,
      state: project.sync_status === 'DORMANT' ? 'clean' : project.worktree_state ?? 'working',
      conflicts: project.worktree_conflicts ? JSON.parse(project.worktree_conflicts) as string[] : [] };
  }

  /** Stops the master and every child that is still working. */
  async stopAll(userId: string, masterId: string): Promise<void> {
    const failures: string[] = [];
    const user = this.context.store.get<User>('SELECT * FROM users WHERE id=?', userId)!;
    await stopSession(this.context, userId, masterId).catch((error: unknown) => failures.push(error instanceof Error ? error.message : String(error)));
    for (const child of this.tasks.children(masterId)) {
      if (!this.context.agents.isBusy(child.id) && !this.tasks.running(child.id).length) continue;
      await this.stopChild(user, child).catch((error: unknown) => failures.push(`${child.agent_name}：${error instanceof Error ? error.message : String(error)}`));
    }
    if (failures.length) throw new HttpError(409, `部分对话未能停止：${failures.join('；')}`);
  }

  deliver(masterId: string): Promise<void> { return this.reports.deliver(masterId, true); }

  publish(masterId: string): void {
    const master = this.context.store.get<Session>('SELECT user_id FROM sessions WHERE id=?', masterId);
    if (master) this.context.events.broadcast(master.user_id, { type: 'agents', sessionId: masterId, payload: this.view(masterId) });
  }
}
