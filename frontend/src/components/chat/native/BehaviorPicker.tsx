import { Check, ChevronDown, ClipboardList, Code2, LoaderCircle, UserRound, Workflow } from "lucide-react";
import type { AgentBehavior, RolePreset } from "../../../types";
import SettingsHelp from "../SettingsHelp";
import SettingsMenu from "../SettingsMenu";
import { engineProfiles, type AgentEngine } from "../../../engines";

export const rolePresets: { value: RolePreset; label: string; description: string }[] = [
  { value: "default", label: "默认助手", description: "按任务需要分析、实现和验证。" },
  { value: "reviewer", label: "代码审阅", description: "优先检查缺陷、回归风险和验证缺口。" },
  { value: "architect", label: "架构设计", description: "优先梳理约束、设计方案和实现步骤。" },
];

export default function BehaviorPicker(props: {
  engine: AgentEngine;
  value: AgentBehavior;
  disabled: boolean;
  saving: boolean;
  openRequest?: number;
  /** Why orchestration cannot change for this conversation; undefined when it can. */
  orchestrationLock?: string;
  onChange: (value: AgentBehavior) => void;
}) {
  const planning = props.value.agentMode === "plan";
  const roleSelectable = engineProfiles[props.engine].rolePresets;
  const orchestrating = engineProfiles[props.engine].orchestration && props.value.orchestration;
  const modes = [
    { value: "normal", label: "Normal", description: "执行任务，操作遵循当前授权模式。" },
    { value: "plan", label: "Plan", description: "先分析并制定计划，确认后再切换 Normal 实施。" },
  ] as const;
  const role = rolePresets.find((item) => item.value === props.value.rolePreset) || rolePresets[0];
  return <SettingsMenu
    label="工作模式与角色"
    width={208}
    className="behavior-trigger"
    title={`${planning ? "Plan · 先规划" : "Normal · 执行任务"}${roleSelectable ? ` · ${role.label}` : ""}${orchestrating ? " · 主智能体" : ""}`}
    openRequest={props.openRequest}
    disabled={props.disabled || props.saving}
    trigger={<>
      <span className="behavior-mode-symbol" aria-hidden="true">
        {props.saving ? <LoaderCircle className="spin" size={18} /> : planning ? <ClipboardList size={18} /> : <Code2 size={18} />}
      </span>
      <span className="settings-trigger-label">{planning ? "Plan" : "Normal"}{roleSelectable && role.value !== "default" ? ` · ${role.label}` : ""}{orchestrating ? " · 主智能体" : ""}</span>
      <ChevronDown className="settings-trigger-chevron" size={12} aria-hidden="true" />
    </>}
  >{(close) => <>
    <div className="settings-menu-heading"><span>工作模式</span><SettingsHelp menuItem text="保存到当前对话，下次发送生效。Shift + Tab 切换工作模式。" /></div>
    {modes.map((mode) => <div className="settings-menu-entry" key={mode.value}>
      <button className="settings-menu-item compact" role="menuitemradio" aria-checked={props.value.agentMode === mode.value}
        aria-description={mode.description} tabIndex={-1} type="button" onClick={() => {
        props.onChange({ ...props.value, agentMode: mode.value }); close();
      }}>
        <span className="settings-item-copy">{mode.label}</span>
        <Check size={14} className="settings-item-check" />
      </button>
      <SettingsHelp text={mode.description} />
    </div>)}
    {roleSelectable && <div className="settings-menu-group" role="group" aria-label="角色预设">
      <div className="settings-menu-heading"><span><UserRound size={13} />角色预设</span></div>
      {rolePresets.map((preset) => <div className="settings-menu-entry" key={preset.value}>
        <button className="settings-menu-item compact" role="menuitemradio" aria-checked={role.value === preset.value}
          aria-description={preset.description} tabIndex={-1} type="button" onClick={() => {
          props.onChange({ ...props.value, rolePreset: preset.value }); close();
        }}>
          <span className="settings-item-copy">{preset.label}</span>
          <Check size={14} className="settings-item-check" />
        </button>
        <SettingsHelp text={preset.description} />
      </div>)}
    </div>}
    {engineProfiles[props.engine].orchestration && <div className="settings-menu-group" role="group" aria-label="编排">
      <div className="settings-menu-heading"><span><Workflow size={13} />编排</span>
        <SettingsHelp menuItem text={props.orchestrationLock ?? (props.engine === "codex"
          ? "主智能体可以派生使用其他 CLI、模型或账号的子智能体。Codex 对话只能在发送第一条消息之前开启或关闭。"
          : "主智能体可以派生使用其他 CLI、模型或账号的子智能体，下次发送生效。")} /></div>
      <div className="settings-menu-entry">
        <button className="settings-menu-item compact" role="menuitemcheckbox" aria-checked={props.value.orchestration}
          disabled={!!props.orchestrationLock} aria-description="作为主智能体派生和指挥子智能体" tabIndex={-1} type="button" onClick={() => {
          props.onChange({ ...props.value, orchestration: !props.value.orchestration }); close();
        }}>
          <span className="settings-item-copy">作为主智能体</span>
          <Check size={14} className="settings-item-check" />
        </button>
      </div>
    </div>}
  </>}</SettingsMenu>;
}
