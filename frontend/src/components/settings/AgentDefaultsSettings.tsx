import { useEffect, useState } from "react";
import { Bot, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { AgentModel, AgentPreference, AgentPreferences, PermissionMode } from "../../types";
import { effortName } from "../chat/ReasoningEffortControl";
import { defaultPermissionMode, permissionOptions } from "../chat/PermissionPicker";
import "../../styles/agent-defaults.css";
import { agentEngines, engineLabel, type AgentEngine } from "../../engines";

interface CatalogSlot { id: string; label: string; model_catalog_at: string | null }
interface AgentSettingsView {
  defaults: AgentPreferences;
  catalogs: Record<AgentEngine, { models: AgentModel[]; slots: CatalogSlot[] }>;
}

/**
 * The user's defaults per CLI: model and reasoning effort, chosen from the catalogs of the slots they may use,
 * and the permission mode new conversations start with.
 */
export default function AgentDefaultsSettings() {
  const [view, setView] = useState<AgentSettingsView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<AgentSettingsView>("/settings/agent", { signal: controller.signal })
      .then(setView)
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, []);
  const engines = view ? agentEngines.filter((engine) => view.catalogs[engine].slots.length) : [];
  return (
    <>
      <div className="settings-section-heading">
        <Bot size={17} />
        <h3>模型、思考强度与授权模式</h3>
      </div>
      <p className="settings-description">
        模型和思考强度用于你所有未单独选择的对话；所用槽位的模型列表中没有该模型、或模型不支持该强度时，改用 CLI 的默认设置。
        授权模式用于新建的对话，单个对话可在输入框底部调整。
      </p>
      {!view && !error && <div className="loading-state">正在读取…</div>}
      {view && !engines.length && <p className="settings-description">你还没有获授权的槽位。</p>}
      {view && engines.map((engine) => (
        <EngineDefaults key={engine} engine={engine} view={view} onSaved={setView} />
      ))}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </>
  );
}

function EngineDefaults({ engine, view, onSaved }: { engine: AgentEngine; view: AgentSettingsView; onSaved: (view: AgentSettingsView) => void }) {
  const saved = view.defaults[engine];
  const { models, slots } = view.catalogs[engine];
  const [draft, setDraft] = useState<AgentPreference>(saved);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const model = models.find((item) => item.id === draft.model);
  // Without a chosen model, any effort some model offers can apply wherever the CLI's default model supports it.
  const efforts = model ? model.reasoningEfforts
    : [...new Map(models.flatMap((item) => item.reasoningEfforts).map((effort) => [effort.value, effort])).values()];
  const dirty = draft.model !== saved.model || draft.reasoningEffort !== saved.reasoningEffort
    || draft.permissionMode !== saved.permissionMode;
  const permissions = permissionOptions(engine);
  const siteDefault = permissions.find((option) => option.value === defaultPermissionMode)?.label;
  async function run(action: string, operation: () => Promise<AgentSettingsView>, done: string) {
    setBusy(action); setError(""); setMessage("");
    try { onSaved(await operation()); setMessage(done); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(""); }
  }
  return (
    <form className="agent-defaults" onSubmit={(event) => {
      event.preventDefault();
      void run("save", () => api<AgentSettingsView>(`/settings/agent/${engine}`, { method: "PUT", body: JSON.stringify(draft) }),
        "已保存。模型和思考强度从下一条消息起生效，授权模式用于之后新建的对话。");
    }}>
      <strong>{engineLabel(engine)}</strong>
      <div className="agent-defaults-fields">
        <label>
          默认模型
          <select value={draft.model ?? ""} disabled={!!busy} onChange={(event) => {
            const next = models.find((item) => item.id === event.target.value);
            setDraft({ ...draft, model: next?.id ?? null,
              reasoningEffort: next && !next.reasoningEfforts.some((effort) => effort.value === draft.reasoningEffort) ? null : draft.reasoningEffort });
            setMessage("");
          }}>
            <option value="">跟随 CLI 默认</option>
            {draft.model && !model && <option value={draft.model}>{draft.model}（不在当前模型列表中）</option>}
            {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          默认思考强度
          <select value={draft.reasoningEffort ?? ""} disabled={!!busy || !efforts.length} onChange={(event) => {
            setDraft({ ...draft, reasoningEffort: event.target.value || null });
            setMessage("");
          }}>
            <option value="">跟随模型默认</option>
            {draft.reasoningEffort && !efforts.some((effort) => effort.value === draft.reasoningEffort)
              && <option value={draft.reasoningEffort}>{effortName(draft.reasoningEffort)}</option>}
            {efforts.map((effort) => <option key={effort.value} value={effort.value}>{effortName(effort.value)}</option>)}
          </select>
        </label>
        <label>
          默认授权模式
          <select value={draft.permissionMode ?? ""} disabled={!!busy} onChange={(event) => {
            setDraft({ ...draft, permissionMode: (event.target.value || null) as PermissionMode | null });
            setMessage("");
          }}>
            <option value="">跟随站点默认（{siteDefault}）</option>
            <optgroup label="CLI 原生">
              {permissions.filter((option) => option.value !== "yolo")
                .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </optgroup>
            <optgroup label="本系统">
              {permissions.filter((option) => option.value === "yolo")
                .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </optgroup>
          </select>
        </label>
        <button type="submit" className="button button-primary button-small" disabled={!!busy || !dirty}>
          {busy === "save" ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存
        </button>
      </div>
      <div className="agent-defaults-sources">
        <small>模型列表来自：</small>
        {slots.map((slot) => (
          <span key={slot.id}>
            <small>{slot.label} · {slot.model_catalog_at ? `更新于 ${new Date(slot.model_catalog_at).toLocaleString("zh-CN")}` : "尚未读取"}</small>
            <button type="button" className="icon-button" disabled={!!busy} aria-label={`刷新 ${slot.label} 的模型列表`} title={`刷新 ${slot.label} 的模型列表`}
              onClick={() => void run(`refresh:${slot.id}`, async () => {
                await post(`/slots/${slot.id}/models/refresh`);
                return api<AgentSettingsView>("/settings/agent");
              }, `已刷新 ${slot.label} 的模型列表。`)}>
              {busy === `refresh:${slot.id}` ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}
            </button>
          </span>
        ))}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {message && <p className="settings-description" role="status">{message}</p>}
    </form>
  );
}
