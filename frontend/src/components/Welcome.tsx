import {
  ArrowUpRight,
  FolderOpen,
  GitBranch,
  Plus,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { Overview, Project } from "../types";
import { BrandMark } from "./Brand";
interface WelcomeProps {
  overview: Overview;
  onNewHost: () => void;
  onNewProject: () => void;
  onSelectProject: (project: Project) => void;
}

export default function Welcome({
  overview,
  onNewHost,
  onNewProject,
  onSelectProject,
}: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome-symbol">
        <BrandMark size={48} />
        <span />
      </div>
      <div className="eyebrow">YOUR SPACE TO BUILD</div>
      <h1>
        把下一次灵感，
        <br />
        变成可以运行的代码。
      </h1>
      <p>
        {overview.user.role === "admin" ? "选择本机或远程项目，" : "连接自己的开发机，选择项目，"}
        <br />与 Claude Code 或 Codex 开始协作。
      </p>
      <div className="welcome-actions">
        <button
          className="button button-primary"
          onClick={overview.hosts.length ? onNewProject : onNewHost}
        >
          <Plus size={16} />
          {overview.hosts.length ? "创建项目" : "连接第一台开发机"}
          <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="welcome-features">
        <div>
          <span>
            <ShieldCheck size={18} />
          </span>
          <strong>可切换账号</strong>
          <small>每个对话独立选择授权账号</small>
        </div>
        <div>
          <span>
            <Terminal size={18} />
          </span>
          <strong>熟悉的环境</strong>
          <small>命令在你的开发机上运行</small>
        </div>
        <div>
          <span>
            <GitBranch size={18} />
          </span>
          <strong>掌控每次变更</strong>
          <small>实时审阅代码与工具审批</small>
        </div>
      </div>
      {overview.projects.length > 0 && (
        <div className="recent-projects">
          <div className="section-label">
            <span>回到项目</span>
            <span>{overview.projects.length} 个项目</span>
          </div>
          {overview.projects.slice(0, 3).map((project) => (
            <button key={project.id} onClick={() => onSelectProject(project)}>
              <FolderOpen size={17} />
              <div>
                <strong>{project.name}</strong>
                <small>{project.remote_path}</small>
              </div>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
