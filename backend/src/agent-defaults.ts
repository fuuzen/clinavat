import { z } from 'zod';
import type { Store } from './database.js';
import { HttpError, type Slot } from './models.js';
import type { AgentModel, AgentPreference } from './agent/model-catalog.js';
import { availableSlots } from './accounts/access.js';
import { permissionModes, validatePermissionMode, type PermissionMode } from './agent/permissions.js';

type Engine = 'claude' | 'codex';
export const agentPreferenceSchema = z.object({
  model: z.string().trim().min(1).max(200).nullable(),
  reasoningEffort: z.string().trim().min(1).max(32).nullable(),
  permissionMode: z.enum(permissionModes).nullable(),
}).strict();
/** A field left null follows the CLI's default, or for the permission mode the site's. */
export type AgentDefaultsEntry = AgentPreference & { permissionMode: PermissionMode | null };
export type AgentPreferences = Record<Engine, AgentDefaultsEntry>;

interface StoredPreference {
  engine: Engine; model: string | null; reasoning_effort: string | null; permission_mode: PermissionMode | null;
}

/** The models a user can choose from: those saved for the slots of this engine the user may use. */
export function userModels(store: Store, userId: string, engine: Engine): { models: AgentModel[]; slots: Pick<Slot, 'id' | 'label' | 'model_catalog_at'>[] } {
  const slots = availableSlots(store, userId).filter(slot => slot.engine === engine);
  const models = new Map<string, AgentModel>();
  for (const slot of slots) {
    for (const model of slot.model_catalog ? JSON.parse(slot.model_catalog) as AgentModel[] : []) {
      const known = models.get(model.id);
      if (!known) { models.set(model.id, model); continue; }
      // The same model may offer different efforts on different accounts; any of them can be a default.
      const efforts = new Map([...known.reasoningEfforts, ...model.reasoningEfforts].map(effort => [effort.value, effort]));
      models.set(model.id, { ...known, reasoningEfforts: [...efforts.values()] });
    }
  }
  return { models: [...models.values()], slots: slots.map(({ id, label, model_catalog_at }) => ({ id, label, model_catalog_at })) };
}

/**
 * Each user's own model and reasoning effort for conversations that leave them to the default, and the
 * permission mode their new conversations start with.
 */
export class AgentDefaults {
  constructor(private readonly store: Store) {}

  user(userId: string): AgentPreferences {
    const unset = { model: null, reasoningEffort: null, permissionMode: null };
    const preferences: AgentPreferences = { claude: { ...unset }, codex: { ...unset } };
    for (const row of this.store.all<StoredPreference>(
      'SELECT engine,model,reasoning_effort,permission_mode FROM user_agent_defaults WHERE user_id=?', userId)) {
      preferences[row.engine] = { model: row.model, reasoningEffort: row.reasoning_effort, permissionMode: row.permission_mode };
    }
    return preferences;
  }

  forUser(userId: string, engine: Engine): AgentDefaultsEntry {
    return this.user(userId)[engine];
  }

  update(userId: string, engine: Engine, preference: AgentDefaultsEntry): AgentPreferences {
    if (preference.permissionMode) validatePermissionMode(engine, preference.permissionMode);
    const { models } = userModels(this.store, userId, engine);
    const model = preference.model ? models.find(item => item.id === preference.model) : undefined;
    if (preference.model && !model) throw new HttpError(400, '所选模型不在你可用槽位的模型列表中，请先刷新模型列表');
    const efforts = model ? model.reasoningEfforts : models.flatMap(item => item.reasoningEfforts);
    if (preference.reasoningEffort && !efforts.some(effort => effort.value === preference.reasoningEffort)) {
      throw new HttpError(400, '所选模型不支持该思考强度');
    }
    this.store.run(`INSERT INTO user_agent_defaults(user_id,engine,model,reasoning_effort,permission_mode) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,engine) DO UPDATE SET model=excluded.model,reasoning_effort=excluded.reasoning_effort,
        permission_mode=excluded.permission_mode`,
    userId, engine, preference.model, preference.reasoningEffort, preference.permissionMode);
    return this.user(userId);
  }
}
