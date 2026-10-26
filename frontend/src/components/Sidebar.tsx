import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Folder,
  FolderPlus,
  GitBranch,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  Search,
  Server,
  Settings2,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { Brand } from "./Auth";
import { isActive, statusLabel } from "../api";
import type { DevHost, Overview, Project, Session } from "../types";

interface Props {
  overview: Overview;
  selectedProject?: Project;
  selectedSession?: Session;
  open: boolean;
  onClose: () => void;
  onSelect: (project: Project, session?: Session) => void;
  onNewHost: () => void;
  onEditHost: (host: DevHost) => void;
  onNewProject: (host?: DevHost) => void;
  onNewSession: (project: Project) => void;
  onConnect: (host: DevHost) => void;
  onDelete: (
    kind: "host" | "project" | "session",
    id: string,
    name: string,
  ) => void;
  onRename: (session: Session) => void;
  onSettings: () => void;
  onLogout: () => void;
}

export default function Sidebar(props: Props) {
  const { overview, selectedProject, selectedSession } = props;
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState("");
  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const matches = (value: string) =>
    value.toLowerCase().includes(search.toLowerCase());
  return (
    <>
      <div
        className={`sidebar-overlay ${props.open ? "visible" : ""}`}
        onClick={props.onClose}
      />
      <aside className={`sidebar ${props.open ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Brand compact />
          <button
            className="icon-button mobile-only"
            onClick={props.onClose}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
          <span className="version-badge">WORKSPACE</span>
        </div>
        <button
          className="new-work-button"
          onClick={() =>
            selectedProject
              ? props.onNewSession(selectedProject)
              : props.onNewProject()
          }
        >
          <Plus size={17} />
          <span>开启新任务</span>
          <kbd>＋</kbd>
        </button>
        <div className="sidebar-search">
          <Search size={14} />
          <input
            placeholder="搜索项目与对话…"
            aria-label="搜索项目与对话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="section-label">
          <span>开发环境</span>
          <button
            className="icon-button"
            onClick={props.onNewHost}
            aria-label="添加开发机"
          >
            <Plus size={15} />
          </button>
        </div>
        <nav className="workspace-tree" aria-label="开发机、项目和对话">
          {overview.hosts.length === 0 && (
            <div className="sidebar-empty">
              <Server size={23} />
              <p>你的工作从这里开始</p>
              <span>
                连接一台开发机，
                <br />
                把熟悉的环境带到工作台。
              </span>
              <button className="text-button" onClick={props.onNewHost}>
                添加开发机 <Plus size={13} />
              </button>
            </div>
          )}
          {overview.hosts.map((host) => {
            const projects = overview.projects.filter(
              (project) => project.dev_host_id === host.id,
            );
            if (
              search &&
              !matches(host.name) &&
              !projects.some(
                (project) =>
                  matches(project.name) ||
                  overview.sessions.some(
                    (session) =>
                      session.project_id === project.id &&
                      matches(session.title),
                  ),
              )
            )
              return null;
            return (
              <div className="host-group" key={host.id}>
                <div className="host-row">
                  <button
                    className="tree-row host-select"
                    onClick={() => toggle(host.id)}
                  >
                    {collapsed.has(host.id) ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <Server size={15} />
                    <span>{host.name}</span>
                    {host.jump_host && (
                      <span className="host-jump-indicator" title={`通过 ${host.jump_username}@${host.jump_host}:${host.jump_port || 22}`}>
                        <Network size={12} aria-label="通过跳板机连接" />
                      </span>
                    )}
                    <span
                      title={statusLabel(host.status)}
                      className={`status-dot ${host.status === "CONNECTED" ? "online" : ""}`}
                    />
                  </button>
                  <div className="row-menu-anchor">
                    <button
                      className="icon-button hover-action"
                      aria-label={`${host.name} 操作`}
                      onClick={() => setMenu(menu === host.id ? "" : host.id)}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {menu === host.id && (
                      <div className="context-menu">
                        <button
                          onClick={() => {
                            props.onEditHost(host);
                            setMenu("");
                          }}
                        >
                          <Pencil size={14} />
                          编辑连接
                        </button>
                        <button
                          onClick={() => {
                            props.onConnect(host);
                            setMenu("");
                          }}
                        >
                          <TerminalSquare size={14} />
                          测试连接
                        </button>
                        <button
                          onClick={() => {
                            props.onNewProject(host);
                            setMenu("");
                          }}
                        >
                          <FolderPlus size={14} />
                          创建项目
                        </button>
                        <button
                          className="danger-text"
                          onClick={() => {
                            props.onDelete("host", host.id, host.name);
                            setMenu("");
                          }}
                        >
                          <Trash2 size={14} />
                          删除开发机
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {!collapsed.has(host.id) && (
                  <div className="host-projects">
                    {projects.map((project) => {
                      const sessions = overview.sessions.filter(
                        (session) => session.project_id === project.id,
                      );
                      if (
                        search &&
                        !matches(host.name) &&
                        !matches(project.name) &&
                        !sessions.some((session) => matches(session.title))
                      )
                        return null;
                      return (
                        <div key={project.id} className="project-group">
                          <div
                            className={`project-row ${selectedProject?.id === project.id ? "project-current" : ""}`}
                          >
                            <button
                              className="tree-row"
                              onClick={() => {
                                props.onSelect(project);
                                if (collapsed.has(project.id))
                                  toggle(project.id);
                              }}
                            >
                              <span
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggle(project.id);
                                }}
                              >
                                {collapsed.has(project.id) ? (
                                  <ChevronRight size={12} />
                                ) : (
                                  <ChevronDown size={12} />
                                )}
                              </span>
                              <Folder size={15} />
                              <span>{project.name}</span>
                            </button>
                            <div className="row-menu-anchor">
                              <button
                                className="icon-button hover-action"
                                aria-label={`${project.name} 操作`}
                                onClick={() =>
                                  setMenu(menu === project.id ? "" : project.id)
                                }
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {menu === project.id && (
                                <div className="context-menu">
                                  <button
                                    onClick={() => {
                                      props.onNewSession(project);
                                      setMenu("");
                                    }}
                                  >
                                    <Plus size={14} />
                                    新建对话
                                  </button>
                                  <button
                                    className="danger-text"
                                    onClick={() => {
                                      props.onDelete(
                                        "project",
                                        project.id,
                                        project.name,
                                      );
                                      setMenu("");
                                    }}
                                  >
                                    <Trash2 size={14} />
                                    删除项目
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          {!collapsed.has(project.id) && (
                            <div className="project-sessions">
                              {sessions
                                .filter(
                                  (session) =>
                                    !search ||
                                    matches(session.title) ||
                                    matches(project.name) ||
                                    matches(host.name),
                                )
                                .map((session) => (
                                  <div
                                    key={session.id}
                                    className={`session-row ${selectedSession?.id === session.id ? "selected" : ""}`}
                                  >
                                    <button
                                      className="tree-row"
                                      onClick={() => {
                                        props.onSelect(project, session);
                                        props.onClose();
                                      }}
                                    >
                                      {isActive(session.status) ? (
                                        <span className="running-dot" />
                                      ) : (
                                        <MessageSquare size={13} />
                                      )}
                                      <span>{session.title}</span>
                                    </button>
                                    <div className="row-menu-anchor">
                                      <button
                                        className="icon-button hover-action"
                                        onClick={() =>
                                          setMenu(
                                            menu === session.id
                                              ? ""
                                              : session.id,
                                          )
                                        }
                                        aria-label="对话操作"
                                      >
                                        <MoreHorizontal size={13} />
                                      </button>
                                      {menu === session.id && (
                                        <div className="context-menu">
                                          <button
                                            onClick={() => {
                                              props.onRename(session);
                                              setMenu("");
                                            }}
                                          >
                                            重命名
                                          </button>
                                          <button
                                            className="danger-text"
                                            onClick={() => {
                                              props.onDelete(
                                                "session",
                                                session.id,
                                                session.title,
                                              );
                                              setMenu("");
                                            }}
                                          >
                                            <Trash2 size={14} />
                                            删除对话
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              <button
                                className="tree-row add-session"
                                onClick={() => props.onNewSession(project)}
                              >
                                <Plus size={13} />
                                <span>新建对话</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {projects.length === 0 && (
                      <button
                        className="tree-row add-project"
                        onClick={() => props.onNewProject(host)}
                      >
                        <Plus size={13} />
                        <span>映射第一个项目</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="slot-summary">
            <div className="slot-icon">
              <GitBranch size={17} />
            </div>
            <div>
              <strong>{overview.slot?.label || "尚未分配账号"}</strong>
              <span>
                {overview.slot
                  ? `${overview.slot.cli_types.join(" / ")} · ${statusLabel(overview.slot.status)}`
                  : "请联系管理员分配独立槽位"}
              </span>
            </div>
            <span
              className={`status-dot ${overview.slot?.status === "ASSIGNED" ? "online" : ""}`}
            />
          </div>
          <button className="sidebar-settings" onClick={props.onSettings}>
            <Settings2 size={16} />
            <span>设置与连接</span>
            <CircleHelp size={14} />
          </button>
          <div className="user-profile">
            <span className="avatar">
              {overview.user.username.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{overview.user.username}</strong>
              <small>
                {overview.user.role === "admin" ? "管理员" : "个人工作空间"}
              </small>
            </div>
            <button
              className="icon-button"
              onClick={props.onLogout}
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
