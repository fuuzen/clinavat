import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import type { Context } from '../context.js';
import { HttpError, type Project, type Session, type User } from '../models.js';
import { workspacePath } from '../agent/environment.js';
import { engineProfiles, type AgentEngine } from '../agent/engines.js';
import { getPermissionMode, permissionModes, type PermissionMode } from '../agent/permissions.js';
import { availableSlots } from '../accounts/access.js';
import { createSession } from '../routes/sessions.js';
import type { toolInputs } from './tools.js';

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

/** Where a child runs when the master named no slot: the automatic choice where some slot qualifies, else the first free slot. */
export function slotChoice(context: Context, user: User, engine: AgentEngine, slotId?: string, model?: string) {
  if (slotId) return { slotMode: 'manual' as const, slotId };
  const slots = engineSlots(context, user.id, engine);
  if (engineProfiles[engine].automaticSlot && slots.some(({ slot }) => context.slots.eligible(slot, user.id, model))) return { slotMode: 'auto' as const };
  // Slot machines cannot share an engine's SQLite session state, so the slot the user already runs it on comes first.
  const shared = context.config.execution.kind === 'vm' && engineProfiles[engine].sessionFiles.length > 0
    && slots.find(entry => entry.usable && context.config.credentials.activeUserId(entry.slot.id) === user.id);
  const free = shared || slots.find(entry => entry.usable);
  if (free) return { slotMode: 'manual' as const, slotId: free.slot.id };
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

export async function createChild(context: Context, user: User, master: Session, input: ChildRequest, placement: Placement): Promise<Session> {
  assertNewName(context, master, input.name);
  const title = `${input.name} · ${input.prompt.replace(/\s+/g, ' ').slice(0, 60)}`;
  return createSession(context, user, {
    projectId: placement.project.id, engine: input.engine, ...slotChoice(context, user, input.engine, input.slot, input.model), title,
    orchestration: false, model: input.model ?? null, reasoningEffort: input.effort ?? null,
    permissionMode: childPermissionMode(master, input.engine), agentMode: 'normal', rolePreset: 'default',
  }, { parentSessionId: master.id, name: input.name, access: input.access, directory: placement.directory, isolation: placement.isolation,
    ephemeral: input.ephemeral, instructions: input.instructions });
}
