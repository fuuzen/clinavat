import type { Context } from '../context.js';
import { projectFor, sessionFor } from '../context.js';
import { HttpError, type Project, type Session, type User } from '../models.js';
import { agentEngines, engineProfiles } from '../agent/engines.js';
import type { AgentContext, AgentEvent, HubToolResult, OrchestrationHost } from '../agent/types.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { stopSession } from '../routes/sessions.js';
import { assertNewName, childDirectory, createChild, engineSlots, type Placement } from './children.js';
import { delegationPrompt, reportBlock } from './instructions.js';
import { orchestrationConstants } from './limits.js';
import { ReportDelivery } from './reports.js';
import { AgentTasks } from './tasks.js';
import { hubTools, isToolName, toolInputs, type ToolName } from './tools.js';

const json = (value: unknown): HubToolResult => ({ text: JSON.stringify(value, null, 1) });
const isActive = (status: string) => ['running', 'waiting', 'pausing', 'paused'].includes(status);

/** Serves the clinavat tools of master agents and follows their children for the agent panel. */
export class Orchestrator implements OrchestrationHost {
  readonly tools = hubTools;
  private readonly tasks: AgentTasks;
  private readonly reports: ReportDelivery;

  constructor(private readonly context: Context) {
    this.tasks = new AgentTasks(context.store);
    this.reports = new ReportDelivery(context, this.tasks, masterId => this.publish(masterId));
  }

  directs(tool: string): boolean { return ['start_agent', 'message_agent', 'merge_agent', 'discard_agent'].includes(tool); }

  observe(event: AgentEvent): void { this.reports.observe(event); }

  async call(agent: AgentContext, tool: string, args: unknown, signal: AbortSignal): Promise<HubToolResult> {
    if (!isToolName(tool)) return { text: `未知的编排工具：${tool}`, isError: true };
    const user = this.context.store.get<User>('SELECT * FROM users WHERE id=?', agent.user.id);
    if (!user) return { text: '用户不存在', isError: true };
    const master = sessionFor(this.context, agent.session.id, user.id);
    if (!master.orchestration || master.parent_session_id) return { text: '当前对话未开启编排', isError: true };
    try {
      return await this.run(tool, user, master, args, signal, agent.session.agent_mode === 'plan');
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private async run(tool: ToolName, user: User, master: Session, args: unknown, signal: AbortSignal, planning: boolean): Promise<HubToolResult> {
    switch (tool) {
      case 'list_agents': {
        toolInputs.list_agents.parse(args ?? {});
        return json(this.list(user, master));
      }
      case 'start_agent': {
        const input = toolInputs.start_agent.parse(args);
        if (planning && input.access === 'write') throw new HttpError(409, 'Plan 模式下只能派生只读子智能体');
        assertNewName(this.context, master, input.name);
        const main = projectFor(this.context, master.project_id, user.id);
        const directory = await childDirectory(main, input.directory);
        const requested = input.access === 'write' ? input.isolation ?? 'worktree' : 'shared';
        this.assertRoom(user, master, { access: input.access, isolation: requested, directory });
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
            this.assertRoom(user, master, { access: input.access, isolation: 'shared', directory });
            notes.push('The directory is not in a Git repository with commits, so the child works in the shared project directory.');
          }
        }
        const child = await createChild(this.context, user, master, input, placement).catch(async (error: unknown) => {
          if (placement.isolation === 'worktree') await this.removeProject(placement.project);
          throw error;
        });
        return this.send(user, master, child, input.prompt, 'queue', input.notify, notes);
      }
      case 'message_agent': {
        const input = toolInputs.message_agent.parse(args);
        const child = this.child(master, input.agent);
        if (planning && child.agent_access === 'write') throw new HttpError(409, 'Plan 模式下不能指挥可写子智能体');
        if (!this.tasks.running(child.id).length) {
          this.assertRoom(user, master, { access: child.agent_access ?? 'write', isolation: child.agent_isolation ?? 'shared', directory: child.agent_directory });
        }
        return this.send(user, master, child, input.message, input.mode, true);
      }
      case 'merge_agent': {
        const input = toolInputs.merge_agent.parse(args);
        return json(await this.merge(this.child(master, input.agent), input.mode, input.onConflict));
      }
      case 'discard_agent': {
        const child = this.worktreeChild(this.child(master, toolInputs.discard_agent.parse(args).agent));
        await this.worktrees.discard(child);
        this.publish(master.id);
        return json({ agent: child.agent_name, status: 'discarded' });
      }
      case 'wait_agents': {
        const input = toolInputs.wait_agents.parse(args);
        const children = input.agents.map(reference => this.child(master, reference));
        const finished = await this.reports.wait(children.map(child => child.id), input.timeoutSeconds * 1000, signal);
        const reports = this.tasks.pending(master.id, children.map(child => child.id));
        this.reports.received(reports);
        return json({
          finished,
          reports: reports.map(task => reportBlock(this.reportSource(children.find(child => child.id === task.child_session_id)!, task))),
          stillRunning: children.filter(child => this.tasks.running(child.id).length).map(child => child.agent_name),
        });
      }
      case 'read_agent': {
        const input = toolInputs.read_agent.parse(args);
        return json(this.read(this.child(master, input.agent), input.turns, input.includeTools));
      }
      case 'stop_agent': {
        const child = this.child(master, toolInputs.stop_agent.parse(args).agent);
        await this.stopChild(user, child);
        return json({ agent: child.agent_name, status: 'stopped' });
      }
    }
  }

  private child(master: Session, reference: string): Session {
    const child = this.tasks.children(master.id).find(item => item.agent_name === reference || item.id === reference);
    if (!child) throw new HttpError(404, `本对话没有名为 ${reference} 的子智能体，请先用 list_agents 查看`);
    if (child.archived_at) throw new HttpError(409, `子智能体 ${reference} 的对话已归档`);
    return child;
  }

  /** Writers in their own worktree only count; writers sharing the project directory must also keep out of each other's directories. */
  private assertRoom(user: User, master: Session, child: { access: 'read' | 'write'; isolation: 'shared' | 'worktree'; directory: string | null }): void {
    const limits = this.context.orchestrationSettings.view();
    const busy = this.tasks.busyChildren({ masterId: master.id });
    if (busy.length >= limits.runningPerMaster) throw new HttpError(409, `本对话已有 ${busy.length} 个子智能体在运行，上限为 ${limits.runningPerMaster}；请等待或停止其中一个`);
    if (this.tasks.busyChildren({ userId: user.id }).length >= limits.runningPerUser) throw new HttpError(409, `你的子智能体同时运行数已达上限 ${limits.runningPerUser}`);
    if (child.access !== 'write') return;
    const writers = busy.filter(item => item.agent_access === 'write' && (item.agent_isolation ?? 'shared') === child.isolation);
    if (child.isolation === 'worktree') {
      if (writers.length >= limits.worktreeWritersPerMaster) throw new HttpError(409, `已有 ${writers.length} 个使用 worktree 的可写子智能体在运行，上限为 ${limits.worktreeWritersPerMaster}`);
      return;
    }
    if (writers.length >= limits.sharedWritersPerMaster) {
      throw new HttpError(409, `共用项目目录的可写子智能体 ${writers.map(item => item.agent_name).join('、') || ''} 已达上限 ${limits.sharedWritersPerMaster}；请等待，或改用 worktree 隔离`);
    }
    const contains = (outer: string | null, inner: string | null) => !outer || outer === inner || !!inner?.startsWith(`${outer}/`);
    const overlapping = writers.filter(item => contains(item.agent_directory, child.directory) || contains(child.directory, item.agent_directory));
    if (overlapping.length) {
      throw new HttpError(409, `可写子智能体 ${overlapping.map(item => `${item.agent_name}（${item.agent_directory ?? '项目根目录'}）`).join('、')} 正在共用目录中修改与 ${child.directory ?? '项目根目录'} 重叠的位置；请换一个不重叠的目录，或改用 worktree 隔离`);
    }
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
    const text = `Merging the branch ${project.worktree_branch} of ${child.agent_name} into the project stopped on conflicts in: ${files.join(', ') || 'unknown files'}. `
      + 'The user asks you to resolve them. Either call merge_agent with onConflict "leave", resolve the markers, commit, and call discard_agent to clean up; '
      + `or ask ${child.agent_name} with message_agent to merge the latest commit of the project into its branch, then call merge_agent again.`;
    await sendSessionMessage(this.context, user, master.id, messageInput.parse({ content: reportBlock({ name: child.agent_name ?? child.id,
      engine: child.engine, model: child.model, status: 'conflict', task: '合并冲突', text }), mode: 'queue' }), { source: 'report', prompt: content => content });
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

  private async send(user: User, master: Session, child: Session, text: string, mode: 'queue' | 'steer' | 'interrupt', notify: boolean, notes: string[] = []) {
    const task = this.tasks.create(master.id, child.id, text, notify);
    this.publish(master.id);
    try {
      const sent = await sendSessionMessage(this.context, user, child.id, messageInput.parse({ content: text, mode }), {
        source: 'delegation',
        prompt: expanded => delegationPrompt(master, { name: child.agent_name!, access: child.agent_access ?? 'write' }, expanded),
      });
      if (child.agent_access === 'write' && child.agent_isolation !== 'worktree') {
        notes.push('This child modifies the shared project directory: do not edit the files it is working on until its report arrives.');
      }
      return json({ agentId: child.agent_name, sessionId: child.id, engine: child.engine, model: child.model ?? 'default', slot: child.slot_id,
        access: child.agent_access, isolation: child.agent_isolation, directory: child.agent_directory ?? '.', status: sent.status,
        ...(notify ? {} : { notify: false }), ...(notes.length ? { notes } : {}) });
    } catch (error) {
      // The master gets the failure as the tool result, so the task needs no report.
      this.tasks.discard(task.id, `任务未能发送：${error instanceof Error ? error.message : String(error)}`);
      this.publish(master.id);
      throw error;
    }
  }

  private async stopChild(user: User, child: Session): Promise<void> {
    await stopSession(this.context, user.id, child.id);
    // A child stopped before its process started reports no turn end.
    await this.reports.complete(sessionFor(this.context, child.id, user.id), 'interrupted', '子智能体已被停止。');
  }

  private list(user: User, master: Session) {
    return {
      engines: agentEngines.map(engine => ({
        engine, label: engineProfiles[engine].label, automaticSlot: engineProfiles[engine].automaticSlot,
        slots: engineSlots(this.context, user.id, engine).map(({ slot, usable, inUseByOther }) => ({
          id: slot.id, label: slot.label, usable, ...(inUseByOther ? { inUseByOtherUser: true } : {}),
          ...(slot.status !== 'IDLE' ? { status: slot.status } : {}),
          models: this.context.config.catalogs.read(slot.id)?.models.map(model => ({
            id: model.id, efforts: model.reasoningEfforts.map(effort => effort.value), ...(model.isDefault ? { default: true } : {}),
          })) ?? 'not read yet: omit model to use the default',
        })),
      })).filter(engine => engine.slots.length),
      children: this.view(master.id).agents.map(({ name, engine, model, access, status, running }) => ({ name, engine, model, access, status, running })),
      limits: { ...this.context.orchestrationSettings.view(), waitSeconds: orchestrationConstants.waitSeconds },
    };
  }

  private read(child: Session, count: number, includeTools: boolean) {
    const turns = this.context.store.all<{ id: string; status: string; items: string; task: string | null; answer: string | null }>(`
      SELECT session_turns.id,session_turns.status,session_turns.items,asked.content AS task,answered.content AS answer FROM session_turns
      LEFT JOIN messages asked ON asked.id=session_turns.user_message_id
      LEFT JOIN messages answered ON answered.id=session_turns.assistant_message_id
      WHERE session_turns.session_id=? ORDER BY session_turns.rowid DESC LIMIT ?`, child.id, count).reverse();
    return {
      agent: child.agent_name, engine: child.engine, model: child.model ?? 'default', status: child.status,
      running: this.tasks.running(child.id).length > 0,
      turns: turns.map(turn => ({
        status: turn.status, message: turn.task?.slice(0, 4000) ?? null, reply: turn.answer ?? null,
        ...(includeTools ? { tools: (JSON.parse(turn.items) as { tool?: { name: string; status?: string; input?: Record<string, unknown> } }[])
          .flatMap(item => item.tool ? [{ name: item.tool.name, status: item.tool.status,
            ...(typeof item.tool.input?.file_path === 'string' ? { file: item.tool.input.file_path } : {}) }] : []).slice(-80) } : {}),
      })),
    };
  }

  private reportSource(child: Session, task: { status: string; prompt: string; report: string | null }) {
    return { name: child.agent_name ?? child.id, engine: child.engine, model: child.model, status: task.status, task: task.prompt, text: task.report ?? '' };
  }

  view(masterId: string) {
    const pending = this.tasks.pending(masterId);
    return {
      agents: this.tasks.children(masterId).map(child => {
        const latest = this.tasks.latest(child.id);
        return {
          sessionId: child.id, name: child.agent_name ?? child.title, engine: child.engine, model: child.model, slotId: child.slot_id,
          access: child.agent_access ?? 'write', status: child.status, archived: !!child.archived_at,
          running: this.tasks.running(child.id).length > 0, directory: child.agent_directory, isolation: child.agent_isolation ?? 'shared',
          worktree: child.agent_isolation === 'worktree' ? this.worktreeView(child) : null,
          lastTask: latest ? { status: latest.status, finishedAt: latest.finished_at } : null,
          pendingReports: pending.filter(task => task.child_session_id === child.id).length,
        };
      }),
      pendingReports: pending.length,
      reportsPaused: pending.length > 0 && this.tasks.reportTurnsSinceUser(masterId) >= this.context.orchestrationSettings.view().reportTurnsPerMessage,
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

  private publish(masterId: string): void {
    const master = this.context.store.get<Session>('SELECT user_id FROM sessions WHERE id=?', masterId);
    if (master) this.context.events.broadcast(master.user_id, { type: 'agents', sessionId: masterId, payload: this.view(masterId) });
  }
}
