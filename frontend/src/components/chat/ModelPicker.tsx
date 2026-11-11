import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, LoaderCircle, RotateCw } from "lucide-react";
import { api, errorText, post } from "../../api";
import type { AgentModel, AgentSelection, ModelCatalog } from "../../types";
import SettingsMenu from "./SettingsMenu";
import ReasoningEffortControl, { effortName } from "./ReasoningEffortControl";

interface Props {
  openRequest?: number;
  engine: "claude" | "codex";
  projectId: string;
  accountKey: string;
  slotId: string;
  accountAvailable: boolean;
  disabled: boolean;
  value: AgentSelection;
  onChange: (value: AgentSelection) => void;
}

function SelectionItem(props: {
  name: string;
  tag?: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="settings-menu-item"
      role="menuitemradio"
      aria-checked={props.selected}
      disabled={props.disabled}
      tabIndex={-1}
      onClick={props.onSelect}
    >
      <span className="settings-item-copy">
        <span className="settings-item-name">
          {props.name}
          {props.tag && <span className="badge">{props.tag}</span>}
        </span>
        {props.description && <small>{props.description}</small>}
      </span>
      <Check size={14} className="settings-item-check" aria-hidden="true" />
    </button>
  );
}

export default function ModelPicker(props: Props) {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const catalogRef = useRef<{ key: string; catalog: ModelCatalog } | null>(null);
  const key = JSON.stringify([props.engine, props.accountKey, props.slotId]);
  function show(catalog: ModelCatalog) {
    catalogRef.current = { key, catalog };
    setModels(catalog.models);
    setRefreshedAt(catalog.refreshedAt);
  }
  useEffect(() => {
    const controller = new AbortController();
    const cached = catalogRef.current?.key === key ? catalogRef.current.catalog : null;
    setError("");
    setModels(cached?.models || []);
    setRefreshedAt(cached?.refreshedAt || null);
    setLoading(false);
    if (!props.accountAvailable || cached) return () => controller.abort();
    setLoading(true);
    const query = new URLSearchParams({ engine: props.engine, slotId: props.slotId });
    // The Hub answers from the slot's saved catalog; only a slot never read before starts its CLI.
    void api<ModelCatalog>(`/agent/models?${query}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) show(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, props.accountAvailable]);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try { show(await post<ModelCatalog>(`/slots/${props.slotId}/models/refresh`)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setRefreshing(false); }
  }
  const selected = props.value.model
    ? models.find((model) => model.id === props.value.model)
    : models.find((model) => model.isDefault);
  const engineName = props.engine === "claude" ? "Claude Code" : "Codex";
  const modelName = selected?.name || props.value.model || `${engineName} 默认`;
  const efforts = selected?.reasoningEfforts || [];
  const currentEffort = effortName(props.value.reasoningEffort || selected?.defaultReasoningEffort);
  const unknownModel = props.value.model && !models.some(
    (model) => model.id === props.value.model,
  );
  return (
    <div className="agent-settings">
      <SettingsMenu
        openRequest={props.openRequest}
        key={`${props.projectId}:${props.slotId}:${props.engine}`}
        label="模型与思考强度"
        role="dialog"
        align="end"
        contentClassName="model-settings-popover"
        title={`${engineName} · ${modelName} · ${currentEffort}${error ? " · 模型列表加载失败" : ""}`}
        className={`model-trigger${error ? " settings-trigger-error" : ""}`}
        disabled={props.disabled}
        trigger={(
          <>
            <span className="settings-trigger-label">{modelName}</span>
            {(efforts.length > 0 || props.value.reasoningEffort) && <span className="model-trigger-effort">{currentEffort}</span>}
            {loading || refreshing ? <LoaderCircle size={12} className="spin" aria-label="正在加载模型" /> : <ChevronDown size={12} aria-hidden="true" />}
          </>
        )}
      >
        {() => (
          <>
            <ReasoningEffortControl
              model={selected}
              value={props.value.reasoningEffort}
              loading={loading}
              onChange={(reasoningEffort) => props.onChange({ ...props.value, reasoningEffort })}
            >
              <SettingsMenu
                label="选择模型"
                title={`选择模型：${modelName}`}
                className="model-settings-model-button"
                align="end"
                trigger={(
                  <>
                    <span className="settings-trigger-label">{modelName}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </>
                )}
              >
                {(close) => (
                  <>
                    <div className="settings-menu-heading">
                      <span>模型</span>
                      <span>{engineName}</span>
                    </div>
                    <div role="group" aria-label="可用模型">
                      {!loading && unknownModel && (
                        <SelectionItem
                          name={props.value.model!}
                          description={error ? "已保存的模型" : "当前账号不支持，请重新选择"}
                          selected
                          disabled
                          onSelect={close}
                        />
                      )}
                      {models.map((model) => (
                        <SelectionItem
                          key={model.id}
                          name={model.name}
                          // Claude's default alias already names itself "Default (recommended)".
                          tag={model.isDefault && !/^default\b/i.test(model.name) ? "默认" : undefined}
                          description={model.description}
                          selected={props.value.model ? props.value.model === model.id : !!model.isDefault}
                          onSelect={() => {
                            // Picking the default model follows the CLI default rather than pinning it.
                            props.onChange({ model: model.isDefault ? null : model.id, reasoningEffort: null });
                            close();
                          }}
                        />
                      ))}
                      {!loading && !models.length && props.value.model && (
                        <SelectionItem
                          name="使用默认模型"
                          selected={false}
                          onSelect={() => {
                            props.onChange({ model: null, reasoningEffort: null });
                            close();
                          }}
                        />
                      )}
                    </div>
                    {loading && <div className="settings-menu-status" role="status">正在加载模型…</div>}
                    {error && <div className="settings-menu-status settings-menu-error" role="status">{error}</div>}
                    {props.accountAvailable && !loading && (
                      <button className="settings-menu-item" type="button" role="menuitem" tabIndex={-1} disabled={refreshing}
                        title="从当前槽位的 CLI 重新读取模型列表" onClick={() => void refresh()}>
                        {refreshing ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
                        <span className="settings-item-copy">
                          <span className="settings-item-name">{refreshing ? "正在刷新模型列表…" : "刷新模型列表"}</span>
                          {refreshedAt && <small>更新于 {new Date(refreshedAt).toLocaleString("zh-CN")}</small>}
                        </span>
                      </button>
                    )}
                  </>
                )}
              </SettingsMenu>
            </ReasoningEffortControl>
            {error && <div className="settings-menu-status settings-menu-error" role="status">模型列表加载失败，请点击模型名称后刷新模型列表。</div>}
          </>
        )}
      </SettingsMenu>
    </div>
  );
}
