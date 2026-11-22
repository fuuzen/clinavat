import type { Context } from '../context.js';
import { sessionFor } from '../context.js';
import { HttpError, type Session, type User } from '../models.js';
import { agentEngines, engineProfiles } from '../agent/engines.js';
import type { AgentContext, AgentEvent, HubToolResult, OrchestrationHost } from '../agent/types.js';
import { messageInput, sendSessionMessage } from '../routes/session-messages.js';
import { stopSession } from '../routes/sessions.js';
import { createChild, engineSlots } from './children.js';
import { delegationPrompt, reportBlock } from './instructions.js';
import { orchestrationLimits } from './limits.js';
import { ReportDelivery } from './reports.js';
import { AgentTasks } from './tasks.js';
import { hubTools, isToolName, toolInputs, type ToolName } from './tools.js';

const json = (value: unknown): HubToolResult => ({ text: JSON.stringify(value, null, 1) });

/** Serves the clinavat tools of master agents and follows their children for the agent panel. */
export class Orchestrator implements OrchestrationHost {
  readonly tools = hubTools;
  private readonly tasks: AgentTasks;
  private readonly reports: ReportDelivery;

  constructor(private readonly context: Context) {
    this.tasks = new AgentTasks(context.store);
    this.reports = new ReportDelivery(context, this.tasks, masterId => this.publish(masterId));
  }

  directs(tool: string): boolean { return tool === 'start_agent' || tool === 'message_agent'; }

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
        this.assertRoom(user, master, input.access === 'write');
        const child = await createChild(this.context, user, master, input);
        return this.send(user, master, child, input.prompt, 'queue', input.notify);
      }
      case 'message_agent': {
        const input = toolInputs.message_agent.parse(args);
        const child = this.child(master, input.agent);
        if (planning && child.agent_access === 'write') throw new HttpError(409, 'Plan 模式下不能指挥可写子智能体');
        if (!this.tasks.running(child.id).length) this.assertRoom(user, master, child.agent_access === 'write');
        return this.send(user, master, child, input.message, input.mode, true);
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

  private assertRoom(user: User, master: Session, writer: boolean): void {
    const { runningPerMaster, runningPerUser, writersPerMaster } = orchestrationLimits;
    const busy = this.tasks.busyChildren({ masterId: master.id });
    if (busy.length >= runningPerMaster) throw new HttpError(409, `本对话已有 ${busy.length} 个子智能体在运行，上限为 ${runningPerMaster}；请等待或停止其中一个`);
    if (this.tasks.busyChildren({ userId: user.id }).length >= runningPerUser) throw new HttpError(409, `你的子智能体同时运行数已达上限 ${runningPerUser}`);
    const writers = busy.filter(child => child.agent_access === 'write');
    if (writer && writers.length >= writersPerMaster) {
      throw new HttpError(409, `可写子智能体 ${writers.map(child => child.agent_name).join('、')} 仍在运行，同时最多 ${writersPerMaster} 个；请等待它完成，或改用只读子智能体`);
    }
  }

  private async send(user: User, master: Session, child: Session, text: string, mode: 'queue' | 'steer' | 'interrupt', notify: boolean) {
    const task = this.tasks.create(master.id, child.id, text, notify);
    this.publish(master.id);
    try {
      const sent = await sendSessionMessage(this.context, user, child.id, messageInput.parse({ content: text, mode }), {
        source: 'delegation',
        prompt: expanded => delegationPrompt(master, { name: child.agent_name!, access: child.agent_access ?? 'write' }, expanded),
      });
      const writing = child.agent_access === 'write'
        ? 'This child may modify files: do not edit the files it is working on until its report arrives.' : undefined;
      return json({ agentId: child.agent_name, sessionId: child.id, engine: child.engine, model: child.model ?? 'default', slot: child.slot_id,
        access: child.agent_access, status: sent.status, ...(notify ? {} : { notify: false }), ...(writing ? { note: writing } : {}) });
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
    this.reports.finish(sessionFor(this.context, child.id, user.id), 'interrupted', '子智能体已被停止。');
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
      limits: orchestrationLimits,
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
          running: this.tasks.running(child.id).length > 0,
          lastTask: latest ? { status: latest.status, finishedAt: latest.finished_at } : null,
          pendingReports: pending.filter(task => task.child_session_id === child.id).length,
        };
      }),
      pendingReports: pending.length,
      reportsPaused: pending.length > 0 && this.tasks.reportTurnsSinceUser(masterId) >= orchestrationLimits.reportTurnsPerMessage,
    };
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
