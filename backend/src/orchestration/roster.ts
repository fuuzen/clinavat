import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../database.js';
import { HttpError, type AgentProfile, type Session } from '../models.js';
import { agentEngines, type AgentEngine } from '../agent/engines.js';
import { slotForUser } from '../accounts/access.js';
import { builtInProfiles, pickBuiltInEngine, resolveBuiltInProfile } from './templates.js';

export const profileInput = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/, '名字只能包含字母、数字、- 和 _，最多 24 个字符'),
  engine: z.enum(agentEngines),
  slotId: z.string().trim().min(1).max(64).nullable().default(null),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  reasoningEffort: z.string().trim().min(1).max(32).nullable().default(null),
  access: z.enum(['read', 'write']).default('read'),
  instructions: z.string().trim().max(8000).nullable().default(null),
}).strict();

/** What a roster entry decides for a child: anything the master set itself still wins. */
export interface ProfileChoice {
  profile?: string; engine?: AgentEngine; model?: string; effort?: string; slot?: string; access?: 'read' | 'write';
}

/** The user's agent roster: named child agents with their CLI, account, model, access and role. */
export class AgentRoster {
  constructor(private readonly store: Store) {}

  list(userId: string): AgentProfile[] {
    return this.store.all<AgentProfile>('SELECT * FROM agent_profiles WHERE user_id=? ORDER BY name', userId);
  }

  /** The profiles this master may start: the conversation's chosen ones, or the whole roster. */
  available(master: Session): AgentProfile[] {
    const all = this.list(master.user_id);
    if (!master.agent_profiles) return all;
    const chosen = JSON.parse(master.agent_profiles) as string[];
    return all.filter(profile => chosen.includes(profile.id));
  }

  /** User profiles available to this master plus non-overridden built-in specialist profiles. */
  effective(master: Session, availableEngines: readonly AgentEngine[] = []) {
    const custom = this.available(master);
    const taken = new Set(custom.map(profile => profile.name));
    return [
      ...custom.map(profile => ({
        name: profile.name, engine: profile.engine, model: profile.model ?? 'default',
        effort: profile.reasoning_effort, slot: profile.slot_id, access: profile.access,
        role: profile.instructions?.slice(0, 300) ?? null, builtIn: false as const,
      })),
      ...builtInProfiles.filter(template => !taken.has(template.name)).map(template => ({
        name: template.name, engine: pickBuiltInEngine(master.engine, availableEngines, template.preferCrossEngine),
        model: 'default', effort: null as string | null, slot: null as string | null, access: template.access,
        role: template.summary, builtIn: true as const,
      })),
    ];
  }

  /** Fills a child's settings from the named profile (user roster first, then built-in templates); returns the role it brings, if any. */
  resolve<T extends ProfileChoice>(
    master: Session,
    choice: T,
    availableEngines: readonly AgentEngine[] = [],
  ): T & { engine: AgentEngine; access: 'read' | 'write'; instructions: string | null } {
    const profile = choice.profile ? this.available(master).find(item => item.name === choice.profile) : undefined;
    const builtIn = !profile && choice.profile ? resolveBuiltInProfile(choice.profile, master.engine, availableEngines) : undefined;
    if (choice.profile && !profile && !builtIn) throw new HttpError(404, `名册中没有本对话可用的 ${choice.profile}，请先用 list_agents 查看`);
    const engine = choice.engine ?? profile?.engine ?? builtIn?.engine;
    if (!engine) throw new HttpError(400, '请指定 engine，或选择名册中的 profile');
    // A profile's account and model belong to its CLI; they do not carry over to another one.
    const same = profile && profile.engine === engine;
    return {
      ...choice, engine, access: choice.access ?? profile?.access ?? builtIn?.access ?? 'read',
      model: choice.model ?? (same ? profile.model ?? undefined : undefined),
      effort: choice.effort ?? (same ? profile.reasoning_effort ?? undefined : undefined),
      slot: choice.slot ?? (same ? profile.slot_id ?? undefined : undefined),
      instructions: profile?.instructions ?? builtIn?.instructions ?? null,
    };
  }

  save(userId: string, input: z.infer<typeof profileInput>, id?: string): AgentProfile {
    if (input.slotId) slotForUser(this.store, input.slotId, userId, input.engine, false);
    const clash = this.store.get<{ id: string }>('SELECT id FROM agent_profiles WHERE user_id=? AND name=?', userId, input.name);
    if (clash && clash.id !== id) throw new HttpError(409, `名册中已有 ${input.name}`);
    const values = [input.name, input.engine, input.slotId, input.model, input.reasoningEffort, input.access, input.instructions] as const;
    if (id) {
      this.find(userId, id);
      this.store.run('UPDATE agent_profiles SET name=?,engine=?,slot_id=?,model=?,reasoning_effort=?,access=?,instructions=? WHERE id=? AND user_id=?',
        ...values, id, userId);
      return this.find(userId, id);
    }
    const created = randomUUID();
    this.store.run('INSERT INTO agent_profiles(name,engine,slot_id,model,reasoning_effort,access,instructions,id,user_id) VALUES(?,?,?,?,?,?,?,?,?)',
      ...values, created, userId);
    return this.find(userId, created);
  }

  remove(userId: string, id: string): void {
    this.find(userId, id);
    this.store.run('DELETE FROM agent_profiles WHERE id=? AND user_id=?', id, userId);
  }

  private find(userId: string, id: string): AgentProfile {
    const profile = this.store.get<AgentProfile>('SELECT * FROM agent_profiles WHERE id=? AND user_id=?', id, userId);
    if (!profile) throw new HttpError(404, '名册中没有这个智能体');
    return profile;
  }
}
