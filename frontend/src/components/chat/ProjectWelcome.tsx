import {
  ArrowUpRight,
  Code2,
  FileSearch,
  GitBranch,
  Laptop,
  Sparkles,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { DevHost, Project, SyncProgress } from "../../types";
import { isClientDirectProject, isClientHost, isClientHostOnline } from "../hosts/client-device";
import SyncProgressBar from "../projects/SyncProgressBar";
import "../../styles/client-devices.css";

const suggestions = [
  { icon: FileSearch, title: "熟悉这个项目", text: "请阅读项目结构，介绍主要模块、技术栈和开发入口。" },
  { icon: Code2, title: "一起实现新功能", text: "请先了解项目现状，再和我讨论要实现的新功能。" },
  { icon: GitBranch, title: "审阅当前改动", text: "请审阅当前工作区的代码变更，指出潜在问题和改进建议。" },
];

export default function ProjectWelcome({
  project,
  host,
  syncProgress,
  maintenance,
  onPickPrompt,
}: {
  project: Project;
  host?: DevHost;
  syncProgress?: SyncProgress;
  maintenance: boolean;
  onPickPrompt: (text: string) => void;
}) {
  const client = isClientHost(host);
  const clientOnline = client && isClientHostOnline(host);
  const clientDirect = isClientDirectProject(project, host);

  return (
    <div className="project-welcome">
      <div className="agent-glyph">
        <Sparkles size={28} strokeWidth={1.4} />
      </div>
      <div className="eyebrow">LET’S BUILD SOMETHING</div>
      <h1>今天，想做些什么？</h1>
      <p>
        你正在 <strong>{project.name}</strong> 中工作。
        <br />
        描述目标，剩下的我们一起完成。
      </p>
      {client && !clientOnline ? (
        <div className="project-client-status-pill offline" role="status">
          <WifiOff size={13} />
          <span>客户端离线，请在桌面客户端确认连接</span>
        </div>
      ) : clientDirect ? (
        <div className="project-client-status-pill" role="status">
          <Laptop size={13} />
          <span>本机直执（实时）</span>
        </div>
      ) : (
        project.sync_status === "CREATING" && <SyncProgressBar progress={syncProgress} />
      )}
      <div className="prompt-suggestions">
        {suggestions.map(({ icon: Icon, title, text }) => (
          <button
            key={title}
            disabled={maintenance}
            title={maintenance ? "系统维护中，暂不支持发起新对话" : undefined}
            onClick={() => onPickPrompt(text)}
          >
            <Icon size={18} />
            <span>{title}</span>
            <ArrowUpRight size={14} />
          </button>
        ))}
      </div>
      <div className="project-location">
        <Terminal size={13} />
        <span>
          {host?.name} <span>/</span> {project.remote_path}
        </span>
      </div>
    </div>
  );
}
