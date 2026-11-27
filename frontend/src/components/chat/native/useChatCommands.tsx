import { useState } from "react";
import { X } from "lucide-react";
import { errorText, post, statusLabel } from "../../../api";
import type { AgentBehavior, AgentSelection, PermissionMode, Session } from "../../../types";
import { rolePresets } from "./BehaviorPicker";
import { effortName } from "../ReasoningEffortControl";
import { parseSlashCommand } from "../composer/commands";
import { engineLabel, engineProfiles, type AgentEngine } from "../../../engines";

const commonCommands = [
  { name: "btw", description: "旁路提问（不打断当前运行、不计入主上下文）", argumentHint: "问题内容" },
  { name: "help", description: "查看命令和键盘快捷键" },
  { name: "clear", description: "新建对话，保留当前历史" },
  { name: "model", description: "打开模型与思考强度选择" },
  { name: "permissions", description: "打开授权模式选择" },
  { name: "plan", description: "切换到 Plan 规划模式" },
  { name: "normal", description: "切换到 Normal 执行模式" },
  { name: "compact", description: "压缩当前原生会话上下文" },
  { name: "rollover", description: "无感续接新底层会话（保留记忆、看板与对话历史）", argumentHint: "[可选保留重点]" },
  { name: "stop", description: "停止当前任务" },
  { name: "pause", description: "暂停当前任务，保留对话进度" },
  { name: "resume", description: "继续已暂停的任务，无需发送消息" },
  { name: "status", description: "查看当前会话配置" },
  { name: "diff", description: "打开项目 Git 变更" },
];

export function useChatCommands(props: {
  engine: AgentEngine;
  session?: Session;
  active: boolean;
  switching: boolean;
  settling: boolean;
  busy: boolean;
  behavior: AgentBehavior;
  selection: AgentSelection;
  permissionMode: PermissionMode;
  onBehavior: (behavior: AgentBehavior) => Promise<boolean>;
  onNew: () => void;
  onStop: () => void;
  onPause: () => Promise<boolean>;
  onResume: () => Promise<boolean>;
  onProjectRefresh: () => Promise<void>;
  onBtw: (question: string) => Promise<boolean>;
  onGoalCommand: (arguments_: string) => Promise<boolean>;
  runStatus?: string;
  onDiff: () => void;
  onNotice: (message: string, kind?: "error" | "success") => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelRequest, setModelRequest] = useState(0);
  const [permissionRequest, setPermissionRequest] = useState(0);
  const [behaviorRequest, setBehaviorRequest] = useState(0);
  const profile = engineProfiles[props.engine];
  const rollover = async (note?: string): Promise<boolean> => {
    if (!props.session) return false;
    try {
      await post(`/sessions/${props.session.id}/rollover`, note ? { note } : {});
      await props.onProjectRefresh();
      props.onNotice("已完成无感上下文续接，下一条消息将启动全新底层会话", "success");
      return true;
    } catch (cause) { props.onNotice(errorText(cause)); return false; }
  };
  const commands = [
    ...commonCommands.filter((command) => command.name !== "compact" || profile.compact),
    ...(profile.orchestration && !props.session?.parent_session_id ? [{ name: "super", description: "切换到 Super Agent 只读统筹编排模式" }] : []),
    ...(profile.rolePresets ? [{ name: "role", description: "切换 Codex 角色预设", argumentHint: "default | reviewer | architect" }] : []),
    ...(profile.goal ? [{ name: "goal", description: "查看、创建或管理原生 Goal", argumentHint: "pause | edit [目标内容] | resume | 目标内容" }] : []),
  ];

  async function handleCommand(content: string): Promise<"message" | "handled" | "retained" | "blocked"> {
    if (content.trim() === "/") { setHelpOpen(true); return "handled"; }
    const match = parseSlashCommand(content);
    if (!match) return "message";
    const name = match.name.toLowerCase();
    const args = match.arguments.trim();
    const fail = (message: string) => { props.onNotice(message); return "blocked" as const; };
    if (name === "btw") {
      if (!args) return fail("请输入旁路问题，例如：/btw 当前改动影响了哪些文件？");
      if (!props.session) return fail("请先发起或选择一个对话，再使用 /btw 旁路提问。");
      if (props.session.archived_at) return fail("对话已归档，请先恢复后再提问。");
      return await props.onBtw(args) ? "handled" : "blocked";
    }
    if (name === "goal") {
      if (!engineProfiles[props.engine].goal) return fail("Goal 仅适用于 Codex 对话。");
      return await props.onGoalCommand(args) ? "handled" : "blocked";
    }
    if (!commands.some((command) => command.name === name)) return fail(`网页暂不支持 /${name}，输入 /help 查看可用命令。`);
    if (!["compact", "role", "rollover", "btw"].includes(name) && args) return fail(`/${name} 不需要参数。`);
    if (name === "help") { setHelpOpen(true); return "handled"; }
    if (name === "stop") { props.onStop(); return "handled"; }
    if (name === "pause" || name === "resume") {
      if (props.settling) return fail("正在结束当前执行，请等待完成，或使用 /stop 停止任务。");
      if (props.switching) return fail("正在切换账号，请等待完成，或使用 /stop 停止任务。");
      if (!props.session || !props.active) return fail("当前没有正在执行的任务。");
      const paused = props.runStatus === "paused" || props.runStatus === "pausing";
      if (name === "pause" && paused) return fail("任务已在暂停中，可使用 /resume 继续。");
      if (name === "resume" && !paused) return fail("当前任务尚未暂停。");
      return await (name === "pause" ? props.onPause() : props.onResume()) ? "retained" : "blocked";
    }
    if (name === "status") {
      const orchestrationLabel = props.behavior.orchestrationMode === "super" ? " · Super Agent" : props.behavior.orchestrationMode === "hybrid" ? " · 协作编排" : "";
      props.onNotice(`${engineLabel(props.engine)} · ${statusLabel(props.session?.status || "idle")} · ${props.behavior.agentMode === "plan" ? "Plan" : "Normal"}${orchestrationLabel} · ${props.selection.model || "默认模型"} · ${props.selection.reasoningEffort ? effortName(props.selection.reasoningEffort) : "默认思考强度"} · ${props.permissionMode}${engineProfiles[props.engine].rolePresets ? ` · ${rolePresets.find((role) => role.value === props.behavior.rolePreset)?.label}` : ""}`, "success");
      return "handled";
    }
    if (name === "diff") { props.onDiff(); return "handled"; }
    if (name === "clear") { props.onNew(); return "handled"; }
    if (props.active || props.busy) return fail("请等待当前任务结束或停止后再修改设置。");
    if (name === "compact") {
      if (!profile.compact) return fail(`${engineLabel(props.engine)} 暂不支持 /compact，可使用 /rollover 无感续接新上下文。`);
      if (!props.session) return fail("当前还没有原生会话可压缩，请先发送一条消息。");
      if (props.engine === "codex" && args) return fail("Codex 的 /compact 暂不接受参数。");
      return "message";
    }
    if (name === "rollover") {
      if (!props.session) return fail("当前对话尚未开始，请先发送一条消息。");
      return await rollover(args || undefined) ? "handled" : "blocked";
    }
    if (name === "model") setModelRequest((value) => value + 1);
    if (name === "permissions") setPermissionRequest((value) => value + 1);
    if ((name === "plan" || name === "normal") && !await props.onBehavior({ ...props.behavior, agentMode: name })) return "blocked";
    if (name === "super") {
      if (props.engine === "codex" && props.session?.native_session_id && props.behavior.orchestrationMode === "off") {
        return fail("Codex 对话在发送第一条消息后不能开启编排。");
      }
      if (!await props.onBehavior({ ...props.behavior, orchestration: true, orchestrationMode: "super" })) return "blocked";
    }
    if (name === "role") {
      if (!args) setBehaviorRequest((value) => value + 1);
      else {
        const role = rolePresets.find((preset) => preset.value === args.toLowerCase());
        if (!role) return fail("角色可选：default、reviewer、architect。");
        if (!await props.onBehavior({ ...props.behavior, rolePreset: role.value })) return "blocked";
      }
    }
    return "handled";
  }
  const help = helpOpen && <section className="chat-command-help" aria-label="命令帮助">
    <header><strong>命令与快捷键</strong><button className="icon-button" aria-label="关闭命令帮助" onClick={() => setHelpOpen(false)}><X size={15} /></button></header>
    <ul>{commands.map((command) => <li key={command.name}><code>/{command.name}</code>{command.description}</li>)}</ul>
    {engineProfiles[props.engine].goal && <p>/goal 查看；/goal 目标内容 创建；/goal pause 暂停目标；/goal edit 编辑；/goal resume 继续目标。Goal 暂停控制目标的自动继续。</p>}
    <p>输入 / 选择命令，@ 引用项目文件；Tab 补全，↑ ↓ 选择，Esc 关闭，Shift + Tab 切换模式，Shift + Enter 换行。</p>
  </section>;
  return { commands, handleCommand, help, modelRequest, permissionRequest, behaviorRequest, rollover };
}
