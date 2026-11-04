import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, LoaderCircle, RotateCw } from "lucide-react";
import { api, errorText } from "../../api";
import type { AgentModel, AgentSelection } from "../../types";
import SettingsMenu from "./SettingsMenu";
import ReasoningEffortControl, { effortName } from "./ReasoningEffortControl";

interface Props {
  openRequest?: number;
  engine: "claude" | "codex";
  projectId: string;
  accountKey: string;
  slotId: string;
  sessionId?: string;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const catalogRef = useRef<{ key: string; retry: number; models: AgentModel[] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const key = JSON.stringify([props.engine, props.projectId, props.accountKey, props.slotId]);
    const cached = catalogRef.current;
    const current = cached?.key === key && cached.retry === retry ? cached.models : null;
    setError("");
    setModels(current || []);
    setLoading(false);
    if (!props.accountAvailable || current) return () => controller.abort();
    setLoading(true);
    const query = new URLSearchParams({
      engine: props.engine,
      projectId: props.projectId,
      slotId: props.slotId,
      ...(props.sessionId ? { sessionId: props.sessionId } : {}),
    });
    void api<{ models: AgentModel[] }>(`/agent/models?${query}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          catalogRef.current = { key, retry, models: result.models };
          setModels(result.models);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [props.engine, props.projectId, props.accountKey, props.slotId, props.sessionId, props.accountAvailable, retry]);
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
        key={`${props.projectId}:${props.accountKey}:${props.engine}`}
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
            {loading ? <LoaderCircle size={12} className="spin" aria-label="正在加载模型" /> : <ChevronDown size={12} aria-hidden="true" />}
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
            </ReasoningEffortControl>
            {error && <div className="settings-menu-status settings-menu-error" role="status">模型列表加载失败，请点击模型名称重试。</div>}
          </>
        )}
      </SettingsMenu>
    </div>
  );
}
