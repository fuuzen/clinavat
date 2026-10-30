import { Check, ChevronDown, ClipboardList, Code2, LoaderCircle, UserRound } from "lucide-react";
import type { AgentBehavior, RolePreset } from "../../../types";
import SettingsMenu from "../SettingsMenu";

export const rolePresets: { value: RolePreset; label: string; description: string }[] = [
  { value: "default", label: "默认助手", description: "按任务需要分析、实现和验证。" },
  { value: "reviewer", label: "代码审阅", description: "优先检查缺陷、回归风险和验证缺口。" },
  { value: "architect", label: "架构设计", description: "优先梳理约束、设计方案和实现步骤。" },
];

export default function BehaviorPicker(props: {
  engine: "claude" | "codex";
  value: AgentBehavior;
  disabled: boolean;
  saving: boolean;
  openRequest?: number;
  onChange: (value: AgentBehavior) => void;
}) {
  const planning = props.value.agentMode === "plan";
  const role = rolePresets.find((item) => item.value === props.value.rolePreset) || rolePresets[0];
  return <SettingsMenu
    label="工作模式与角色"
    className="behavior-trigger"
    title={`${planning ? "Plan · 先规划" : "Normal · 执行任务"}${props.engine === "codex" ? ` · ${role.label}` : ""}`}
    openRequest={props.openRequest}
    disabled={props.disabled || props.saving}
    trigger={<>
      <span className="behavior-mode-symbol" aria-hidden="true">
        {props.saving ? <LoaderCircle className="spin" size={18} /> : planning ? <ClipboardList size={18} /> : <Code2 size={18} />}
      </span>
      <span className="settings-trigger-label">{planning ? "Plan" : "Normal"}{props.engine === "codex" && role.value !== "default" ? ` · ${role.label}` : ""}</span>
      <ChevronDown className="settings-trigger-chevron" size={12} aria-hidden="true" />
    </>}
  >{(close) => <>
    <div className="settings-menu-heading">工作模式</div>
    {([
      { value: "normal", label: "Normal", description: "执行任务，操作遵循当前授权模式。" },
      { value: "plan", label: "Plan", description: "先分析并制定计划，确认后再切换 Normal 实施。" },
    ] as const).map((mode) => <button key={mode.value} className="settings-menu-item" role="menuitemradio" aria-checked={props.value.agentMode === mode.value} tabIndex={-1} type="button" onClick={() => {
      props.onChange({ ...props.value, agentMode: mode.value }); close();
    }}>
      <span className="settings-item-copy"><span>{mode.label}</span><small>{mode.description}</small></span>
      <Check size={14} className="settings-item-check" />
    </button>)}
    {props.engine === "codex" && <>
      <div className="settings-menu-heading"><UserRound size={13} />角色预设</div>
      {rolePresets.map((preset) => <button key={preset.value} className="settings-menu-item" role="menuitemradio" aria-checked={role.value === preset.value} tabIndex={-1} type="button" onClick={() => {
        props.onChange({ ...props.value, rolePreset: preset.value }); close();
      }}>
        <span className="settings-item-copy"><span>{preset.label}</span><small>{preset.description}</small></span>
        <Check size={14} className="settings-item-check" />
      </button>)}
    </>}
    <div className="settings-menu-footnote">保存到当前对话，下次发送生效。Shift + Tab 切换工作模式。</div>
  </>}</SettingsMenu>;
}
