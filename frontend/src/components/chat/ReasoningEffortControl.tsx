import { useId, type CSSProperties, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { AgentModel } from "../../types";

interface Props {
  model?: AgentModel;
  value: string | null;
  loading: boolean;
  onChange: (value: string | null) => void;
  children: ReactNode;
}

export default function ReasoningEffortControl(props: Props) {
  const descriptionId = useId();
  const efforts = props.model?.reasoningEfforts || [];
  const defaultIndex = efforts.findIndex((effort) => effort.value === props.model?.defaultReasoningEffort);
  // Some catalogs omit the default effort, so keep an explicit default stop in that case.
  const stops = defaultIndex < 0
    ? [{ value: null, label: "默认" }, ...efforts]
    : efforts;
  const currentIndex = props.value
    ? stops.findIndex((effort) => effort.value === props.value)
    : Math.max(0, defaultIndex);
  const unknownEffort = !!props.value && currentIndex < 0;
  const index = Math.max(0, currentIndex);
  const label = unknownEffort ? props.value : stops[index]?.label || "默认";
  const progress = stops.length > 1 ? index / (stops.length - 1) * 100 : 0;
  const adjustable = !props.loading && efforts.length > 0;

  return (
    <>
      <div className="model-settings-summary">
        <div className="reasoning-effort-name" aria-live="polite">{props.loading ? "加载中…" : label}</div>
        <button
          className="reasoning-effort-reset"
          type="button"
          title="恢复默认思考强度"
          aria-label="恢复默认思考强度"
          disabled={props.loading}
          onClick={() => props.onChange(null)}
        >
          <RotateCcw size={17} aria-hidden="true" />
        </button>
        {props.children}
      </div>
      {adjustable && (
        <div className="reasoning-effort-control">
          <div className="reasoning-effort-slider" style={{ "--effort-progress": `${progress}%` } as CSSProperties}>
            <div className="reasoning-effort-track" aria-hidden="true">
              {stops.map((effort, stopIndex) => (
                <span
                  key={effort.value || "default"}
                  className="reasoning-effort-tick"
                  style={{ left: `clamp(8px, ${stopIndex / Math.max(1, stops.length - 1) * 100}%, calc(100% - 8px))` }}
                />
              ))}
              <span className="reasoning-effort-thumb" />
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(1, stops.length - 1)}
              step={1}
              value={index}
              disabled={stops.length < 2}
              aria-label="思考强度"
              aria-valuetext={unknownEffort ? `已保存：${label}，当前模型不支持` : `${label}${!props.value ? "，跟随模型默认" : ""}`}
              aria-describedby={descriptionId}
              onChange={(event) => props.onChange(stops[Number(event.target.value)].value)}
            />
          </div>
          <div className="reasoning-effort-scale" aria-hidden="true">
            <span>{stops[0].label}</span>
            <span>{stops.at(-1)?.label}</span>
          </div>
        </div>
      )}
      <div id={descriptionId} className="model-settings-note">
        {props.loading ? "正在加载可用模型…"
          : unknownEffort ? "已保存的强度不可用，请调整滑动条或恢复默认。"
          : !props.model ? "选择模型后可调整思考强度。"
          : !efforts.length ? "此模型未提供可调节的思考强度。"
          : !props.value ? "跟随模型默认 · 下次发送时生效"
          : "思考强度 · 下次发送时生效"}
      </div>
    </>
  );
}
