import type { z } from 'zod';
import type { Context } from '../context.js';
import { HttpError, type Session, type User } from '../models.js';
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
function slotChoice(context: Context, user: User, engine: AgentEngine, slotId?: string, model?: string) {
  if (slotId) return { slotMode: 'manual' as const, slotId };
  const slots = engineSlots(context, user.id, engine);
  if (engineProfiles[engine].automaticSlot && slots.some(({ slot }) => context.slots.eligible(slot, user.id, model))) return { slotMode: 'auto' as const };
  const free = slots.find(entry => entry.usable);
  if (free) return { slotMode: 'manual' as const, slotId: free.slot.id };
  throw new HttpError(409, slots.length
    ? `没有可用的 ${engineProfiles[engine].label} 槽位：${slots.map(({ slot, inUseByOther }) => `${slot.id}（${inUseByOther ? '其他用户正在使用' : slot.status}）`).join('、')}`
    : `当前用户没有 ${engineProfiles[engine].label} 槽位`);
}

export async function createChild(context: Context, user: User, master: Session, input: z.infer<typeof toolInputs.start_agent>): Promise<Session> {
  const { store } = context;
  if (store.get('SELECT id FROM sessions WHERE parent_session_id=? AND agent_name=?', master.id, input.name)) {
    throw new HttpError(409, `已有名为 ${input.name} 的子智能体，请用 message_agent 继续与它对话，或换一个名字`);
  }
  const title = `${input.name} · ${input.prompt.replace(/\s+/g, ' ').slice(0, 60)}`;
  return createSession(context, user, {
    projectId: master.project_id, engine: input.engine, ...slotChoice(context, user, input.engine, input.slot, input.model), title,
    orchestration: false, model: input.model ?? null, reasoningEffort: input.effort ?? null,
    permissionMode: childPermissionMode(master, input.engine), agentMode: 'normal', rolePreset: 'default',
  }, { parentSessionId: master.id, name: input.name, access: input.access });
}
