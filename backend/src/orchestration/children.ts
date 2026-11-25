import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError, type Project, type Session, type Slot, type User } from '../models.js';
import { workspacePath } from '../agent/environment.js';
import { engineProfiles, type AgentEngine } from '../agent/engines.js';
import { validateAgentSelection } from '../agent/model-catalog.js';
import { getPermissionMode, permissionModes, type PermissionMode } from '../agent/permissions.js';
import { availableSlots, slotForUser } from '../accounts/access.js';
import { assertAutomaticSlot } from '../accounts/selection.js';
import { selectedSlotId } from '../routes/session-messages.js';
import { createSession, stopSession } from '../routes/sessions.js';
import type { toolInputs } from './tools.js';
import type { AgentTasks } from './tasks.js';

/** The child's mode never grants more than the master's; an engine without that mode gets the next stricter one. */
export function childPermissionMode(master: Pick<Session, 'permission_mode'>, engine: AgentEngine): PermissionMode {
  const ceiling = permissionModes.indexOf(getPermissionMode(master));
  const allowed = engineProfiles[engine].permissionModes;
  return [...permissionModes].slice(0, ceiling + 1).reverse().find(mode => allowed.includes(mode)) ?? 'manual';
}

/** The slots the user may run the engine on, as list_agents shows them and start_agent picks from. */
export function engineSlots(context: Context, userId: string, engine: AgentEngine) {
  return availableSlots(context.store, userId).filter(slot => slot.engine === engine).map(slot => {
    const user = context.config.credentials.activeUserId(slot.id);
    return { slot, usable: slot.status === 'IDLE' && (!user || user === userId), inUseByOther: !!user && user !== userId };
  });
}

function pickRankedManualSlot(context: Context, user: User, engine: AgentEngine, candidates: Slot[], model?: string | null): Slot | undefined {
  if (!candidates.length) return undefined;
  const pinnedSlotId = context.config.credentials.activeSlotForUser(user.id, engine);
  if (pinnedSlotId) {
    const pinned = candidates.find(slot => slot.id === pinnedSlotId);
    if (pinned) return pinned;
  }
  const effectiveModel = model ?? context.agentDefaults.forUser(user.id, engine).model;
  const supportsModel = effectiveModel
    ? (slotId: string) => {
        const catalog = context.config.catalogs.read(slotId);
        return !catalog || catalog.models.some(item => item.id === effectiveModel);
      }
    : undefined;
  return context.slots.rankSlots(candidates, engine, effectiveModel, supportsModel)[0];
}

/** Where a child runs when the master named no slot: keep auto for automatic-slot engines when any non-token slot can participate, else rank usable slots. */
export function slotChoice(context: Context, user: User, engine: AgentEngine, slotId?: string, model?: string) {
  if (slotId) return { slotMode: 'manual' as const, slotId };
  const slots = engineSlots(context, user.id, engine);
  const usable = slots.filter(entry => entry.usable);
  if (engineProfiles[engine].automaticSlot) {
    // Do not require a 60s-fresh cached reading here: SlotSelector.select() refreshes and ranks eligible slots and enables runtime failover.
    const hasAutoSlot = usable.some(({ slot }) => slot.auth_method !== 'token' && !context.slots.isBlocked(slot, model));
    if (hasAutoSlot) return { slotMode: 'auto' as const };
  }
  // Respect VM single-machine SQLite exclusivity first, then pick the healthiest non-limited slot.
  const free = pickRankedManualSlot(context, user, engine, usable.map(entry => entry.slot), model);
  if (free) return { slotMode: 'manual' as const, slotId: free.id };
  throw new HttpError(409, slots.length
    ? `没有可用的 ${engineProfiles[engine].label} 槽位：${slots.map(({ slot, inUseByOther }) => `${slot.id}（${inUseByOther ? '其他用户正在使用' : slot.status}）`).join('、')}`
    : `当前用户没有 ${engineProfiles[engine].label} 槽位`);
}

export function assertNewName(context: Context, master: Session, name: string): void {
  if (context.store.get('SELECT id FROM sessions WHERE parent_session_id=? AND agent_name=?', master.id, name)) {
    throw new HttpError(409, `已有名为 ${name} 的子智能体，请用 message_agent 继续与它对话，或换一个名字`);
  }
}

/** A project-relative directory that exists in the project; null for the root. */
export async function childDirectory(project: Project, requested?: string): Promise<string | null> {
  const value = requested?.trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!value || value === '.') return null;
  if (path.posix.isAbsolute(value) || value.split('/').includes('..')) throw new HttpError(400, 'directory 必须是项目内的相对路径');
  const full = await workspacePath(project.local_path, value).catch((error: unknown) => {
    throw new HttpError(400, `目录 ${value} 不可用：${error instanceof Error ? error.message : String(error)}`);
  });
  if (!(await stat(full).catch(() => undefined))?.isDirectory()) throw new HttpError(400, `项目中没有目录 ${value}`);
  return path.posix.normalize(value);
}

/** Where a child works: its project (the master's, or its own worktree project), directory and isolation. */
export interface Placement { project: Project; directory: string | null; isolation: 'shared' | 'worktree' }

/** A start_agent request whose roster profile has been applied. */
export type ChildRequest = z.infer<typeof toolInputs.start_agent> & { engine: AgentEngine; access: 'read' | 'write'; instructions: string | null };

/** Writers sharing a checkout must keep their directories from overlapping. */
export function assertChildRoom(context: Context, tasks: AgentTasks, user: User, master: Session,
  child: { access: 'read' | 'write'; isolation: 'shared' | 'worktree'; directory: string | null }): void {
  const limits = context.orchestrationSettings.view();
  const busy = tasks.busyChildren({ masterId: master.id });
  if (busy.length >= limits.runningPerMaster) throw new HttpError(409, `本对话已有 ${busy.length} 个子智能体在运行，上限为 ${limits.runningPerMaster}；请等待或停止其中一个`);
  if (tasks.busyChildren({ userId: user.id }).length >= limits.runningPerUser) throw new HttpError(409, `你的子智能体同时运行数已达上限 ${limits.runningPerUser}`);
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

export async function createChild(context: Context, user: User, master: Session, input: ChildRequest, placement: Placement): Promise<Session> {
  assertNewName(context, master, input.name);
  const title = `${input.name} · ${input.prompt.replace(/\s+/g, ' ').slice(0, 60)}`;
  const choice = slotChoice(context, user, input.engine, input.slot, input.model);
  const base = {
    projectId: placement.project.id, engine: input.engine, title, orchestration: false,
    model: input.model ?? null, reasoningEffort: input.effort ?? null,
    permissionMode: childPermissionMode(master, input.engine), agentMode: 'normal' as const, rolePreset: 'default' as const,
  };
  const childMeta = {
    parentSessionId: master.id, name: input.name, access: input.access, directory: placement.directory,
    isolation: placement.isolation, ephemeral: input.ephemeral, instructions: input.instructions, profile: input.profile,
  };
  try {
    return await createSession(context, user, { ...base, ...choice }, childMeta);
  } catch (error) {
    if (choice.slotMode !== 'auto' || !(error instanceof HttpError) || error.statusCode !== 409) throw error;
    // Only fall back when every auto-schedulable slot failed and a usable long-lived token slot can still serve the engine.
    const tokenSlots = engineSlots(context, user.id, input.engine)
      .filter(entry => entry.usable && entry.slot.auth_method === 'token' && !context.slots.isBlocked(entry.slot, input.model))
      .map(entry => entry.slot);
    const fallback = pickRankedManualSlot(context, user, input.engine, tokenSlots, input.model);
    if (!fallback) throw error;
    return createSession(context, user, { ...base, slotMode: 'manual', slotId: fallback.id }, childMeta);
  }
}

export interface ChildReconfigureInput {
  slot?: string;
  model?: string;
  effort?: string;
  mode: 'queue' | 'steer' | 'interrupt';
}

/** Safely validates and applies optional slot/model/effort changes on a child before sending a continuation message. */
export async function reconfigureChild(
  context: Context,
  user: User,
  tasks: AgentTasks,
  child: Session,
  input: ChildReconfigureInput,
): Promise<{ child: Session; notes: string[] }> {
  const wantsAuto = input.slot === 'auto';
  const wantsSlot = input.slot !== undefined && !wantsAuto;
  const slotChanging = (wantsAuto && child.slot_mode !== 'auto')
    || (wantsSlot && (child.slot_mode !== 'manual' || child.slot_id !== input.slot));
  const modelChanging = input.model !== undefined && input.model !== child.model;
  const effortChanging = input.effort !== undefined && input.effort !== child.reasoning_effort;
  if (!slotChanging && !modelChanging && !effortChanging) return { child, notes: [] };

  // Validate basic slot eligibility before interrupting an active child.
  if (wantsAuto) assertAutomaticSlot(child.engine);
  if (wantsSlot) {
    if (!selectedSlotId.safeParse(input.slot).success) throw new HttpError(400, '槽位 ID 格式无效');
    const target = slotForUser(context.store, input.slot!, user.id, child.engine);
    const occupant = context.config.credentials.activeUserId(target.id);
    if (occupant && occupant !== user.id) throw new HttpError(409, `槽位 ${target.id} 正由其他用户使用，请换其他可用槽位`);
  }

  const runtime = context.agents.view(child.id);
  const activelyRunning = tasks.running(child.id).length > 0 || runtime.turnActive || !!runtime.switching || !!runtime.settling
    || runtime.queue.length > 0 || context.agents.hasBackgroundWork(child.id)
    || ['running', 'waiting', 'pausing', 'paused'].includes(child.status);
  if (activelyRunning) {
    if (input.mode !== 'interrupt') {
      throw new HttpError(409, `子智能体 ${child.agent_name} 正在运行，切换 slot/model/effort 需等待当前轮次结束，或将 mode 设为 "interrupt" 先中断再切换`);
    }
    await stopSession(context, user.id, child.id);
    const runningIds = tasks.running(child.id).map(task => task.id);
    if (runningIds.length) {
      const ended = tasks.finish(child.id, 'interrupted', '主智能体已中断当前轮次以切换槽位或模型。', runningIds);
      tasks.delivered(ended.map(task => task.id));
    }
  }

  return withResourceLocks(context, [`session:${child.id}`], async () => {
    const current = sessionFor(context, child.id, user.id);
    await context.agents.reclaim(current.id);
    if (context.agents.isBusy(current.id) || ['running', 'waiting', 'pausing', 'paused'].includes(current.status)
      || context.config.credentials.isSessionBusy(current.id)) {
      throw new HttpError(409, '子智能体仍在运行或回收状态，请等待结束或先停止后再切换槽位/模型');
    }
    const nextSlotMode = wantsAuto ? 'auto' as const : wantsSlot ? 'manual' as const : current.slot_mode;
    let nextModel = input.model !== undefined ? input.model : current.model;
    let nextEffort = input.effort !== undefined ? input.effort
      : (input.model !== undefined && input.model !== current.model ? null : current.reasoning_effort);

    let targetSlot: Slot;
    if (nextSlotMode === 'auto') {
      assertAutomaticSlot(current.engine);
      targetSlot = await context.slots.select(
        { userId: user.id, engine: current.engine, model: nextModel, preferredSlotId: wantsAuto ? undefined : current.slot_id },
        candidate => validateAgentSelection(context.config, { user, slot: candidate, session: { engine: current.engine } },
          { model: nextModel, reasoningEffort: nextEffort }),
      );
    } else {
      const targetSlotId = wantsSlot ? input.slot! : current.slot_id;
      if (!targetSlotId) throw new HttpError(409, '子智能体尚未绑定授权槽位，请指定 slot');
      targetSlot = slotForUser(context.store, targetSlotId, user.id, current.engine);
      const occupant = context.config.credentials.activeUserId(targetSlot.id);
      if (occupant && occupant !== user.id) throw new HttpError(409, `槽位 ${targetSlot.id} 正由其他用户使用，请换其他可用槽位`);
      const pinnedSlotId = context.config.credentials.activeSlotForUser(user.id, current.engine);
      if (pinnedSlotId && pinnedSlotId !== targetSlot.id) {
        const label = context.store.get<{ label: string }>('SELECT label FROM account_slots WHERE id=?', pinnedSlotId)?.label ?? pinnedSlotId;
        throw new HttpError(409, `你的 ${engineProfiles[current.engine].label} 正在槽位 ${label} 上运行，它的会话数据库不能同时在两台槽位虚拟机中使用；请改用槽位 ${label}，或等那里的对话结束后再试`);
      }
      try {
        await validateAgentSelection(context.config, { user, slot: targetSlot, session: { engine: current.engine } },
          { model: nextModel, reasoningEffort: nextEffort });
      } catch (error) {
        // When switching slots without explicitly naming model/effort, fall back to the new slot's default if the previous model is unavailable.
        if (wantsSlot && targetSlot.id !== current.slot_id && input.model === undefined && input.effort === undefined
          && error instanceof HttpError && error.statusCode === 400) {
          nextModel = null;
          nextEffort = null;
          await validateAgentSelection(context.config, { user, slot: targetSlot, session: { engine: current.engine } },
            { model: null, reasoningEffort: null });
        } else {
          throw error;
        }
      }
    }

    context.store.run(
      "UPDATE sessions SET slot_id=?,slot_mode=?,model=?,reasoning_effort=?,updated_at=datetime('now') WHERE id=?",
      targetSlot.id, nextSlotMode, nextModel, nextEffort, current.id,
    );
    const updated = sessionFor(context, current.id, user.id);
    context.events.emit(user.id, { type: 'session', sessionId: current.id, payload: updated });
    const changes: string[] = [];
    if (updated.slot_id !== current.slot_id || updated.slot_mode !== current.slot_mode) {
      changes.push(`slot=${updated.slot_id} (${updated.slot_mode})`);
    }
    if (updated.model !== current.model) changes.push(`model=${updated.model ?? 'default'}`);
    if (updated.reasoning_effort !== current.reasoning_effort) changes.push(`effort=${updated.reasoning_effort ?? 'default'}`);
    return { child: updated, notes: changes.length ? [`Updated child runtime settings before continuing: ${changes.join(', ')}.`] : [] };
  });
}
