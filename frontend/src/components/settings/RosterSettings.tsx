import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Pencil, Plus, Trash2, Users } from "lucide-react";
import { api, errorText } from "../../api";
import { agentEngines, engineProfiles, type AgentEngine } from "../../engines";
import type { AgentProfile, Overview } from "../../types";

type Draft = { id?: string; name: string; engine: AgentEngine; slotId: string; model: string; reasoningEffort: string; access: "read" | "write"; instructions: string };

const blank = (engine: AgentEngine): Draft => ({ name: "", engine, slotId: "", model: "", reasoningEffort: "", access: "read", instructions: "" });

/** The user's agent roster: named child agents a master starts by name, with their CLI, account, model, access and role. */
export default function RosterSettings({ overview }: { overview: Overview }) {
  const engines = agentEngines.filter((engine) => overview.slots.some((slot) => slot.engine === engine));
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = () => api<AgentProfile[]>("/agent-profiles").then(setProfiles, (cause) => setError(errorText(cause)));
  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true); setError("");
    const body = { name: draft.name.trim(), engine: draft.engine, slotId: draft.slotId || null, model: draft.model.trim() || null,
      reasoningEffort: draft.reasoningEffort.trim() || null, access: draft.access, instructions: draft.instructions.trim() || null };
    try {
      await api(draft.id ? `/agent-profiles/${draft.id}` : "/agent-profiles", { method: draft.id ? "PUT" : "POST", body: JSON.stringify(body) });
      setDraft(null);
      await load();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }
  async function remove(profile: AgentProfile) {
    setError("");
    try { await api(`/agent-profiles/${profile.id}`, { method: "DELETE" }); await load(); }
    catch (cause) { setError(errorText(cause)); }
  }

  return (
    <div className="roster-settings">
      <div className="settings-section-heading">
        <Users size={17} />
        <h3>智能体名册</h3>
      </div>
      <p className="settings-description">
        给常用的子智能体起名字，主智能体用名字派生它们，讨论中也可以直接选用。名册中的设置是默认值，主智能体仍可以逐项覆盖；
        每个主对话可以在输入框的「工作模式与角色」菜单中限定可用的智能体。
      </p>
      {!profiles && !error && <div className="loading-state">正在读取…</div>}
      {profiles && !profiles.length && !draft && <p className="form-hint">名册还是空的。</p>}
      {profiles?.map((profile) => (
        <div key={profile.id} className="roster-entry">
          <span className={`engine-logo engine-logo-${profile.engine}`} aria-hidden="true" />
          <strong>{profile.name}</strong>
          <span className="roster-entry-meta">
            {[profile.model || "默认模型", profile.reasoning_effort, profile.access === "read" ? "只读" : "可写",
              overview.slots.find((slot) => slot.id === profile.slot_id)?.label].filter(Boolean).join(" · ")}
          </span>
          {profile.instructions && <span className="roster-entry-role" title={profile.instructions}>{profile.instructions}</span>}
          <button type="button" className="icon-button" aria-label={`编辑 ${profile.name}`} onClick={() => setDraft({
            id: profile.id, name: profile.name, engine: profile.engine, slotId: profile.slot_id ?? "", model: profile.model ?? "",
            reasoningEffort: profile.reasoning_effort ?? "", access: profile.access, instructions: profile.instructions ?? "" })}><Pencil size={13} /></button>
          <button type="button" className="icon-button danger-text" aria-label={`删除 ${profile.name}`} onClick={() => void remove(profile)}><Trash2 size={13} /></button>
        </div>
      ))}
      {draft ? (
        <form className="roster-form" onSubmit={save}>
          <div className="form-row">
            <label>名字<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={24}
              pattern="[A-Za-z0-9][A-Za-z0-9_-]*" title="字母、数字、- 和 _" placeholder="reviewer" disabled={saving} /></label>
            <label>CLI<select value={draft.engine} onChange={(event) => setDraft({ ...draft, engine: event.target.value as AgentEngine, slotId: "" })} disabled={saving}>
              {engines.map((engine) => <option key={engine} value={engine}>{engineProfiles[engine].label}</option>)}
            </select></label>
          </div>
          <div className="form-row">
            <label>账号<select value={draft.slotId} onChange={(event) => setDraft({ ...draft, slotId: event.target.value })} disabled={saving}>
              <option value="">由本系统选择</option>
              {overview.slots.filter((slot) => slot.engine === draft.engine).map((slot) => <option key={slot.id} value={slot.id}>{slot.label}</option>)}
            </select></label>
            <label>读写<select value={draft.access} onChange={(event) => setDraft({ ...draft, access: event.target.value as "read" | "write" })} disabled={saving}>
              <option value="read">只读</option>
              <option value="write">可写（默认在独立 worktree 中）</option>
            </select></label>
          </div>
          <div className="form-row">
            <label>模型<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="留空使用账号默认" disabled={saving} /></label>
            <label>思考强度<input value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })} placeholder="留空使用模型默认" disabled={saving} /></label>
          </div>
          <label>角色说明<textarea value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} rows={3} maxLength={8000}
            placeholder="例如：你负责安全审查，关注注入、鉴权和敏感信息泄露。" disabled={saving} /></label>
          <div className="modal-actions">
            <button type="button" className="button button-ghost" onClick={() => setDraft(null)} disabled={saving}>取消</button>
            <button className="button button-primary" disabled={saving || !draft.name.trim()}>{saving && <LoaderCircle className="spin" size={15} />}保存</button>
          </div>
        </form>
      ) : (
        <button type="button" className="button button-secondary button-small" disabled={!engines.length} onClick={() => setDraft(blank(engines[0]))}>
          <Plus size={13} />添加智能体
        </button>
      )}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div>
  );
}
