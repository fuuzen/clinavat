import { useEffect, useState } from "react";
import { Brain, Check, ChevronDown, LoaderCircle, RotateCw } from "lucide-react";
import { api, errorText } from "../../api";
import type { AgentModel, AgentSelection } from "../../types";
import SettingsMenu from "./SettingsMenu";

interface Props {
  engine: "claude" | "codex";
  engines: string[];
  engineLocked: boolean;
  projectId: string;
  disabled: boolean;
  value: AgentSelection;
  onChange: (value: AgentSelection) => void;
  onEngineChange: (engine: "claude" | "codex") => void;
}

function SelectionItem(props: {
  name: string;
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
        <span>{props.name}</span>
        {props.description && <small>{props.description}</small>}
      </span>
      <Check size={14} className="settings-item-check" aria-hidden="true" />
    </button>
  );
}

export default function ModelPicker(props: Props) {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setModels([]);
    const query = new URLSearchParams({
      engine: props.engine,
      projectId: props.projectId,
    });
    void api<{ models: AgentModel[] }>(`/agent/models?${query}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setModels(result.models);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [props.engine, props.projectId, retry]);
  const selected = props.value.model
    ? models.find((model) => model.id === props.value.model)
    : models.find((model) => model.isDefault);
  const engineName = props.engine === "claude" ? "Claude Code" : "Codex";
  const modelName = selected?.name || props.value.model || `${engineName} 默认`;
  const defaultModel = models.find((model) => model.isDefault);
  const efforts = selected?.reasoningEfforts || [];
  const effortName = efforts.find((effort) => effort.value === props.value.reasoningEffort)?.label
    || props.value.reasoningEffort || "默认";
  const defaultEffort = efforts.find((effort) => effort.value === selected?.defaultReasoningEffort);
  const unknownModel = props.value.model && !models.some(
    (model) => model.id === props.value.model,
  );
  const unknownEffort = props.value.reasoningEffort && !efforts.some(
    (effort) => effort.value === props.value.reasoningEffort,
  );
  return (
    <div className="agent-settings">
      <SettingsMenu
        key={props.projectId}
        label="模型"
        title={`${engineName} · ${modelName}${error ? " · 模型列表加载失败，点击重试" : ""}`}
        className={`model-trigger${error ? " settings-trigger-error" : ""}`}
        disabled={props.disabled}
        trigger={(
          <>
            <span className={`engine-symbol engine-${props.engine}`} aria-hidden="true">
              {props.engine === "claude" ? "✳" : "◈"}
            </span>
            <span className="settings-trigger-label">{modelName}</span>
            {loading ? <LoaderCircle size={12} className="spin" aria-label="正在加载模型" /> : <ChevronDown size={12} aria-hidden="true" />}
          </>
        )}
      >
        {(close) => (
          <>
            <div className="settings-menu-heading">
              <span>模型</span>
              {props.engineLocked && <span>{engineName}</span>}
            </div>
            {!props.engineLocked && (
              <div className="settings-engine-choices" role="group" aria-label="CLI 引擎">
                {(["claude", "codex"] as const)
                  .filter((engine) => props.engines.includes(engine))
                  .map((engine) => (
                    <button
                      key={engine}
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.engine === engine}
                      tabIndex={-1}
                      onClick={() => {
                        props.onEngineChange(engine);
                        close();
                      }}
                    >
                      <span className={`engine-symbol engine-${engine}`} aria-hidden="true">
                        {engine === "claude" ? "✳" : "◈"}
                      </span>
                      {engine === "claude" ? "Claude Code" : "Codex"}
                    </button>
                  ))}
              </div>
            )}
            <div role="group" aria-label="可用模型">
              <SelectionItem
                name="跟随默认"
                description={defaultModel?.name}
                selected={!props.value.model}
                disabled={loading}
                onSelect={() => {
                  props.onChange({ model: null, reasoningEffort: null });
                  close();
                }}
              />
              {!loading && unknownModel && (
                <SelectionItem name={props.value.model!} description="已保存的模型" selected onSelect={close} />
              )}
              {models.map((model) => (
                <SelectionItem
                  key={model.id}
                  name={model.name}
                  description={model.description}
                  selected={props.value.model === model.id}
                  onSelect={() => {
                    props.onChange({ model: model.id, reasoningEffort: null });
                    close();
                  }}
                />
              ))}
            </div>
            {loading && <div className="settings-menu-status" role="status">正在加载模型…</div>}
            {error && (
              <>
                <div className="settings-menu-status settings-menu-error" role="status">{error}</div>
                <button className="settings-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={() => setRetry((value) => value + 1)}>
                  <RotateCw size={14} />
                  重新加载模型
                </button>
              </>
            )}
          </>
        )}
      </SettingsMenu>
      {(efforts.length > 0 || props.value.reasoningEffort) && (
        <SettingsMenu
          key={`${props.projectId}:${props.engine}:${props.value.model || "default"}`}
          label="思考强度"
          title={`思考强度：${effortName}`}
          className="effort-trigger"
          disabled={props.disabled || loading || efforts.length === 0}
          trigger={(
            <>
              <Brain size={13} aria-hidden="true" />
              <span className="settings-trigger-label">{effortName}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </>
          )}
        >
          {(close) => (
            <>
              <div className="settings-menu-heading"><span>思考强度</span></div>
              <SelectionItem
                name="默认"
                description={defaultEffort ? `当前默认：${defaultEffort.label}` : "使用模型的默认设置"}
                selected={!props.value.reasoningEffort}
                onSelect={() => {
                  props.onChange({ ...props.value, reasoningEffort: null });
                  close();
                }}
              />
              {unknownEffort && <SelectionItem name={props.value.reasoningEffort!} description="已保存的设置" selected onSelect={close} />}
              {efforts.map((effort) => (
                <SelectionItem
                  key={effort.value}
                  name={effort.label}
                  selected={props.value.reasoningEffort === effort.value}
                  onSelect={() => {
                    props.onChange({ ...props.value, reasoningEffort: effort.value });
                    close();
                  }}
                />
              ))}
              <div className="settings-menu-footnote">下次发送消息时生效</div>
            </>
          )}
        </SettingsMenu>
      )}
    </div>
  );
}
