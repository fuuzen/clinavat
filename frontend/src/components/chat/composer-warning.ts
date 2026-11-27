import { statusLabel } from "../../api";
import type { AccountSelection, DevHost, Project, Slot } from "../../types";
import { isClientDirectProject, isClientHost, isClientHostOnline } from "../hosts/client-device";

interface WarningInput {
  maintenance: boolean;
  active: boolean;
  slotAvailable: boolean;
  accountSelection: AccountSelection;
  occupied: boolean;
  slot?: Slot;
  slotId?: string;
  project?: Project;
  host?: DevHost;
  syncReady: boolean;
}

export function getComposerWarning(input: WarningInput): string | undefined {
  if (input.maintenance) {
    return input.active
      ? "系统维护中，当前为只读模式：暂不支持发送消息，仍可暂停、继续或停止当前任务，以及处理待确认审批与提问。"
      : "系统维护中，当前为只读模式，暂不支持发送消息或发起新对话。";
  }
  if (!input.slotAvailable) {
    if (input.accountSelection.slotMode === "auto") {
      return "当前没有可用的 Claude 账号，请等待账号释放或联系管理员。";
    }
    if (input.occupied) {
      return "此槽位正由其他用户使用，释放后可继续；也可选择其他已获授权的账号。";
    }
    if (input.slot) {
      return `此槽位${statusLabel(input.slot.status)}，请选择其他可用账号或联系管理员。`;
    }
    if (input.slotId) {
      return "此对话原选槽位已不可访问，请选择同引擎的其他授权槽位。";
    }
    return "请选择已获授权的账号槽位；没有可用账号时请联系管理员。";
  }
  if (isClientHost(input.host) && !isClientHostOnline(input.host)) {
    return "客户端离线，请在桌面客户端确认连接。";
  }
  if (input.project?.sync_status === "CREATING") {
    return "项目正在同步，完成后即可发送任务。";
  }
  if (!input.syncReady) {
    if (isClientDirectProject(input.project, input.host)) {
      return "客户端直执目录当前异常，请检查本机目录访问权限或客户端连接状态。";
    }
    if (input.project?.execution_mode === "local") {
      return "本机项目目录不可用。恢复目录及其访问权限后，请在工作区点击「检查目录」。";
    }
    return "项目同步尚未就绪。请在工作区点击「立即同步」恢复后发送任务。";
  }
  return undefined;
}
