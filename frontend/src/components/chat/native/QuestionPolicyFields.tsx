import { useId, useState } from "react";
import type { QuestionPolicy, QuestionPreference } from "../../../types";
import { durationLabel, modeLabel, questionModeOptions, questionTimeoutMinutes, questionTimeoutPresets } from "./questionPolicy";
import "../../../styles/question-policy.css";

interface Props {
  value: QuestionPreference;
  /** Offered as a "follow defaults" choice for each setting; without it both must be chosen. */
  inherited?: QuestionPolicy;
  inheritedLabel?: string;
  disabled?: boolean;
  onChange: (value: QuestionPreference) => void;
}

export default function QuestionPolicyFields({ value, inherited, inheritedLabel = "跟随默认", disabled, onChange }: Props) {
  const name = useId();
  const [custom, setCustom] = useState(value.timeoutMs !== null && !questionTimeoutPresets.includes(value.timeoutMs));
  const [minutes, setMinutes] = useState(value.timeoutMs === null ? "" : String(Math.round(value.timeoutMs / 60_000)));
  const timeoutChoice = custom ? "custom" : value.timeoutMs === null ? "inherit" : String(value.timeoutMs);
  return (
    <fieldset className="question-policy-fields" disabled={disabled}>
      <div className="question-policy-group" role="radiogroup" aria-label="无人回答时">
        <span className="question-policy-label">无人回答时</span>
        {inherited && (
          <label className="question-policy-option">
            <input type="radio" name={name} checked={value.mode === null} onChange={() => onChange({ ...value, mode: null })} />
            <span><strong>{inheritedLabel}</strong><small>当前为「{modeLabel(inherited.mode)}」</small></span>
          </label>
        )}
        {questionModeOptions.map((option) => (
          <label className="question-policy-option" key={option.value}>
            <input type="radio" name={name} checked={value.mode === option.value} onChange={() => onChange({ ...value, mode: option.value })} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </div>
      <label className="question-policy-timeout">
        <span className="question-policy-label">等待回答的时间</span>
        <select value={timeoutChoice} onChange={(event) => {
          const choice = event.target.value;
          setCustom(choice === "custom");
          if (choice === "custom") {
            const current = value.timeoutMs ?? inherited?.timeoutMs ?? questionTimeoutPresets[1];
            setMinutes(String(Math.round(current / 60_000)));
            onChange({ ...value, timeoutMs: current });
          } else onChange({ ...value, timeoutMs: choice === "inherit" ? null : Number(choice) });
        }}>
          {inherited && <option value="inherit">{inheritedLabel}（{durationLabel(inherited.timeoutMs)}）</option>}
          {questionTimeoutPresets.map((preset) => <option key={preset} value={preset}>{durationLabel(preset)}</option>)}
          <option value="custom">自定义…</option>
        </select>
      </label>
      {custom && (
        <label className="question-policy-custom">
          <input type="number" inputMode="numeric" required min={questionTimeoutMinutes.min} max={questionTimeoutMinutes.max} step={1}
            value={minutes} aria-label="自定义等待时间（分钟）" onChange={(event) => {
              setMinutes(event.target.value);
              const parsed = Number(event.target.value);
              if (Number.isInteger(parsed) && parsed >= questionTimeoutMinutes.min && parsed <= questionTimeoutMinutes.max) {
                onChange({ ...value, timeoutMs: parsed * 60_000 });
              }
            }} />
          <span>分钟（1–1440）</span>
        </label>
      )}
      <p className="question-policy-note">暂停期间不计时。含密码类输入的问题不会转为待回答，到时按跳过处理。</p>
    </fieldset>
  );
}
