import type { ReactNode } from "react";
import { Check, ChevronDown, Hand, LoaderCircle, LockOpen, PencilLine, ShieldCheck, Zap, type LucideIcon } from "lucide-react";
import type { PermissionMode } from "../../types";
import SettingsHelp from "./SettingsHelp";
import SettingsMenu from "./SettingsMenu";
import "../../styles/permission-modes.css";
import { engineLabel, engineProfiles, type AgentEngine } from "../../engines";

interface Props {
  openRequest?: number;
  engine: AgentEngine;
  value: PermissionMode;
  disabled: boolean;
  saving: boolean;
  onChange: (mode: PermissionMode) => void;
}

export interface PermissionOption {
  value: PermissionMode;
  label: string;
  icon: LucideIcon;
  description: string;
}

const nativeOptions: PermissionOption[] = [
  { value: "manual", label: "按需审批", icon: Hand, description: "由 CLI 决定何时请求确认，在网页中批准或拒绝。" },
  { value: "accept-edits", label: "自动接受编辑", icon: PencilLine, description: "Claude Code 自动接受文件编辑，其他操作按原生规则审批。" },
  { value: "auto", label: "自动审批", icon: ShieldCheck, description: "由 CLI 原生审核器判断允许或拒绝，仍可能阻止操作。" },
  { value: "full-access", label: "Full access", icon: LockOpen, description: "使用 CLI 原生完整访问模式，跳过常规权限确认。" },
];
const yoloOption: PermissionOption = {
  value: "yolo", label: "YOLO", icon: Zap,
  description: "本系统自动批准全部工具审批，不经过 CLI 自动审核。",
};

/** New conversations start here unless the user has chosen another default. */
export const defaultPermissionMode: PermissionMode = "auto";

/** The site default where the CLI offers it, else asking for each tool, as the Hub does. */
export const defaultPermissionModeFor = (engine: AgentEngine): PermissionMode =>
  engineProfiles[engine].permissionModes.includes(defaultPermissionMode) ? defaultPermissionMode : "manual";

const nativeOptionsFor = (engine: AgentEngine) => nativeOptions.filter((option) => engineProfiles[engine].permissionModes.includes(option.value));

export function permissionOptions(engine: AgentEngine): PermissionOption[] {
  return [...nativeOptionsFor(engine), yoloOption];
}

export function selectedPermissionOption(engine: AgentEngine, value: PermissionMode): PermissionOption {
  return permissionOptions(engine).find((option) => option.value === value) || nativeOptions[0];
}

export function PermissionMenuBody(props: {
  engine: AgentEngine;
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  close: () => void;
  headingPrefix?: ReactNode;
}) {
  const options = nativeOptionsFor(props.engine);
  function item(option: PermissionOption) {
    const OptionIcon = option.icon;
    return (
      <div className="settings-menu-entry" key={option.value}>
        <button
          className={`settings-menu-item compact permission-option permission-${option.value}`}
          type="button"
          role="menuitemradio"
          aria-checked={props.value === option.value}
          aria-description={option.description}
          tabIndex={-1}
          onClick={() => {
            props.close();
            if (props.value !== option.value) props.onChange(option.value);
          }}
        >
          <span className="permission-mode-symbol" aria-hidden="true"><OptionIcon size={18} /></span>
          <span className="settings-item-copy">{option.label}</span>
          <Check size={14} className="settings-item-check" aria-hidden="true" />
        </button>
        <SettingsHelp text={option.description} />
      </div>
    );
  }
  return (
    <>
      <div className="settings-menu-heading">
        <span className="settings-menu-title">{props.headingPrefix}<span>授权模式</span></span>
        <SettingsHelp menuItem text="保存到当前对话，下次发送消息时生效。" />
      </div>
      <div role="group" aria-label="CLI 原生授权">
        <div className="settings-menu-heading"><span>CLI 原生</span><span>{engineLabel(props.engine)}</span></div>
        {options.map((option) => item(option))}
      </div>
      <div className="settings-menu-group" role="group" aria-label="本系统自动审批">
        <div className="settings-menu-heading"><span>本系统</span></div>
        {item(yoloOption)}
      </div>
    </>
  );
}

export default function PermissionPicker(props: Props) {
  const selected = selectedPermissionOption(props.engine, props.value);
  const Icon = selected.icon;
  return (
    <SettingsMenu
      openRequest={props.openRequest}
      label="授权模式"
      width={232}
      title={`授权模式：${selected.label}${props.saving ? " · 正在保存" : ""}`}
      className={`permission-trigger permission-${selected.value}`}
      disabled={props.disabled || props.saving}
      trigger={(
        <>
          <span className="permission-mode-symbol" aria-hidden="true">
            {props.saving ? <LoaderCircle size={18} className="spin" /> : <Icon size={18} />}
          </span>
          <span className="settings-trigger-label permission-label">{selected.label}</span>
          <ChevronDown size={12} className="settings-trigger-chevron" aria-hidden="true" />
        </>
      )}
    >
      {(close) => <PermissionMenuBody engine={props.engine} value={props.value} onChange={props.onChange} close={close} />}
    </SettingsMenu>
  );
}
