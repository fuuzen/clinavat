import { useState } from "react";
import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Folder,
  Laptop,
  LogOut,
  MessagesSquare,
  Monitor,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import Brand from "./Brand";
import HostMenu from "./sidebar/HostMenu";
import SessionRow from "./sidebar/SessionRow";
import SessionGroup, { groupSessions } from "./sidebar/SessionGroup";
import ClientDeviceCard from "./hosts/ClientDeviceCard";
import {
  clientPlatformLabel,
  isClientDirectProject,
  isClientHost,
  isClientHostOnline,
} from "./hosts/client-device";
import ClientHubSwitch from "./ClientHubSwitch";
import SyncProgressBar from "./projects/SyncProgressBar";
import { statusLabel } from "../api";
import type { DevHost, Overview, Project, Session, SyncProgress } from "../types";

interface Props {
  overview: Overview;
  selectedProject?: Project;
  selectedSession?: Session;
  open: boolean;
  onClose: () => void;
  onSelect: (project: Project, session?: Session) => void;
  syncProgress: Record<string, SyncProgress>;
  onNewHost: () => void;
  onEditHost: (host: DevHost) => void;
  onNewProject: (host?: DevHost) => void;
  onConnect: (host: DevHost) => void;
  onRefresh: () => Promise<void>;
  onNotice?: (message: string, kind?: "error" | "success") => void;
  onDelete: (kind: "host" | "project" | "session", id: string, name: string) => void;
  onRename: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  /** Starts a discussion among CLIs in the project. */
  onDiscuss: (project: Project) => void;
  /** Opens persistent project memories in a browsable modal. */
  onMemory: (project: Project) => void;
  onSettings: () => void;
  adminOpen: boolean;
  onAdmin: () => void;
  onLogout: () => void;
}

export default function Sidebar(props: Props) {
  const { overview, selectedProject, selectedSession } = props;
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState("");
  const maintenanceEnabled = !!overview.maintenance?.enabled;
  const maintenanceTip = "系统维护中，当前为只读模式，暂不支持新建对话或变更资源";
  const waiting = new Set(overview.deferredQuestions.map((item) => item.session_id));
  const activeSessions = overview.sessions.filter((session) => !session.archived_at);
  const worktreeParents = new Map(
    overview.projects.flatMap((project) => project.parent_project_id ? [[project.id, project.parent_project_id] as const] : []),
  );
  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());

  return (
    <>
      <div className={`sidebar-overlay ${props.open ? "visible" : ""}`} onClick={props.onClose} />
      <aside className={`sidebar ${props.open ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Brand compact />
          <button className="icon-button mobile-only" onClick={props.onClose} aria-label="关闭导航">
            <X size={18} />
          </button>
        </div>
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
            disabled={maintenanceEnabled}
            title={maintenanceEnabled ? maintenanceTip : "添加开发机"}
            aria-label="添加开发机"
          >
            <Plus size={15} />
          </button>
        </div>
        <nav className="workspace-tree" aria-label="开发机、项目和对话">
          <ClientDeviceCard
            hosts={overview.hosts}
            variant="compact"
            readOnly={maintenanceEnabled}
            readOnlyReason={maintenanceTip}
            onRefresh={props.onRefresh}
            onNotice={props.onNotice}
          />
          {overview.hosts.length === 0 && (
            <div className="sidebar-empty">
              <Server size={23} />
              <p>你的工作从这里开始</p>
              <span>
                连接一台开发机，
                <br />
                把熟悉的环境带到工作台。
              </span>
              <button
                className="text-button"
                onClick={props.onNewHost}
                disabled={maintenanceEnabled}
                title={maintenanceEnabled ? maintenanceTip : undefined}
              >
                添加开发机 <Plus size={13} />
              </button>
            </div>
          )}
          {overview.hosts.map((host) => {
            const client = isClientHost(host);
            const online = client ? isClientHostOnline(host) : host.status === "CONNECTED";
            const projects = overview.projects.filter(
              (project) => project.dev_host_id === host.id && !project.parent_project_id,
            );
            if (
              search &&
              !matches(host.name) &&
              !projects.some(
                (project) =>
                  matches(project.name) ||
                  activeSessions.some(
                    (session) =>
                      (session.project_id === project.id || worktreeParents.get(session.project_id) === project.id) &&
                      matches(session.title),
                  ),
              )
            )
              return null;
            const hostTitle = host.kind === "local"
              ? "号池机本机 · 管理员专用"
              : client
                ? `${clientPlatformLabel(host.device?.platform)} 客户端 · ${online ? "在线" : "客户端离线，请在桌面客户端确认连接"}`
                : undefined;
            return (
              <div className="host-group" key={host.id}>
                <div className="host-row">
                  <button className="tree-row host-select" onClick={() => toggle(host.id)}>
                    {collapsed.has(host.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    {host.kind === "local" ? <Monitor size={15} /> : client ? <Laptop size={15} /> : <Server size={15} />}
                    <span title={hostTitle}>{host.name}</span>
                    {!client && host.jump_host && (
                      <span className="host-jump-indicator" title={`通过 ${host.jump_username}@${host.jump_host}:${host.jump_port || 22}`}>
                        <Network size={12} aria-label="通过跳板机连接" />
                      </span>
                    )}
                    <span
                      title={client ? (online ? "客户端已连接" : "客户端离线，请在桌面客户端确认连接") : statusLabel(host.status)}
                      className={`status-dot ${online ? "online" : ""}`}
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
                      <HostMenu
                        host={host}
                        maintenanceEnabled={maintenanceEnabled}
                        maintenanceTip={maintenanceTip}
                        onEditHost={props.onEditHost}
                        onConnect={props.onConnect}
                        onNewProject={props.onNewProject}
                        onDeleteHost={(target) => props.onDelete("host", target.id, target.name)}
                        onRefresh={props.onRefresh}
                        onNotice={props.onNotice}
                        onClose={() => setMenu("")}
                      />
                    )}
                  </div>
                </div>
                {!collapsed.has(host.id) && (
                  <div className="host-projects">
                    {projects.map((project) => {
                      // A child agent in its own worktree is listed under its master's project.
                      const sessions = activeSessions.filter(
                        (session) => session.project_id === project.id || worktreeParents.get(session.project_id) === project.id,
                      );
                      if (
                        search &&
                        !matches(host.name) &&
                        !matches(project.name) &&
                        !sessions.some((session) => matches(session.title))
                      )
                        return null;
                      const clientDirect = isClientDirectProject(project, host);
                      return (
                        <div key={project.id} className="project-group">
                          <div className={`project-row ${selectedProject?.id === project.id ? "project-current" : ""}`}>
                            <button
                              className="tree-row"
                              title={
                                maintenanceEnabled
                                  ? "维护中仅可浏览项目与历史对话，暂不支持发起新对话"
                                  : client && !online
                                    ? "客户端离线，请在桌面客户端确认连接"
                                    : clientDirect
                                      ? "本机直执（实时）"
                                      : undefined
                              }
                              onClick={() => {
                                props.onSelect(project);
                                if (collapsed.has(project.id)) toggle(project.id);
                                props.onClose();
                              }}
                            >
                              <span onClick={(event) => { event.stopPropagation(); toggle(project.id); }}>
                                {collapsed.has(project.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                              </span>
                              <Folder size={15} />
                              <span>{project.name}</span>
                            </button>
                            <div className="row-menu-anchor">
                              <button
                                className="icon-button hover-action"
                                aria-label={`${project.name} 操作`}
                                onClick={() => setMenu(menu === project.id ? "" : project.id)}
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {menu === project.id && (
                                <div className="context-menu">
                                  <button
                                    disabled={maintenanceEnabled}
                                    title={maintenanceEnabled ? maintenanceTip : undefined}
                                    onClick={() => { props.onDiscuss(project); setMenu(""); }}
                                  >
                                    <MessagesSquare size={14} />
                                    发起讨论
                                  </button>
                                  <button onClick={() => { props.onMemory(project); setMenu(""); }}>
                                    <BookMarked size={14} />
                                    项目记忆
                                  </button>
                                  <button
                                    className="danger-text"
                                    disabled={maintenanceEnabled}
                                    title={maintenanceEnabled ? maintenanceTip : undefined}
                                    onClick={() => {
                                      props.onDelete("project", project.id, project.name);
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
                          {client && !online ? (
                            <div className="sidebar-project-mode offline">客户端离线</div>
                          ) : clientDirect ? (
                            <div className="sidebar-project-mode">本机直执（实时）</div>
                          ) : project.sync_status === "CREATING" && (
                            <SyncProgressBar compact progress={props.syncProgress[project.id]} />
                          )}
                          {!collapsed.has(project.id) && (
                            <div className="project-sessions">
                              {groupSessions(sessions)
                                .filter(
                                  (entry) =>
                                    !search ||
                                    [entry.session, ...entry.children].some((session) => matches(session.title)) ||
                                    matches(project.name) ||
                                    matches(host.name),
                                )
                                .map((entry) => <SessionGroup key={entry.session.id} entry={entry} selectedId={selectedSession?.id} renderRow={(session, accessory) => (
                                  <SessionRow
                                    key={session.id}
                                    accessory={accessory}
                                    session={session}
                                    selected={selectedSession?.id === session.id}
                                    waiting={waiting.has(session.id) || (session.id === entry.session.id && entry.children.some((child) => waiting.has(child.id)))}
                                    readOnly={maintenanceEnabled}
                                    menuOpen={menu === session.id}
                                    onToggleMenu={() => setMenu(menu === session.id ? "" : session.id)}
                                    onSelect={() => {
                                      props.onSelect(overview.projects.find((item) => item.id === session.project_id) ?? project, session);
                                      props.onClose();
                                    }}
                                    onRename={() => { props.onRename(session); setMenu(""); }}
                                    onArchive={() => { props.onArchive(session, true); setMenu(""); }}
                                    onDelete={() => { props.onDelete("session", session.id, session.title); setMenu(""); }}
                                  />
                                )} />)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {projects.length === 0 && (
                      <button
                        className="tree-row add-project"
                        disabled={maintenanceEnabled}
                        title={maintenanceEnabled ? maintenanceTip : undefined}
                        onClick={() => props.onNewProject(host)}
                      >
                        <Plus size={13} />
                        <span>{host.kind === "local" || client ? "打开第一个项目" : "映射第一个项目"}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-settings" onClick={props.onSettings}>
            <Settings2 size={16} />
            <span>工作台设置</span>
            <CircleHelp size={14} />
          </button>
          <div className="user-profile">
            <span className="avatar">{overview.user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{overview.user.username}</strong>
              <small>{overview.user.role === "admin" ? "管理员" : "个人工作空间"}</small>
            </div>
            {overview.user.role === "admin" && (
              <button
                className={`icon-button sidebar-admin-entry ${props.adminOpen ? "active" : ""}`}
                onClick={() => { props.onAdmin(); props.onClose(); }}
                aria-pressed={props.adminOpen}
                title={props.adminOpen ? "返回工作台" : "打开管理面板"}
                aria-label={props.adminOpen ? "返回工作台" : "打开管理面板"}
              >
                <ShieldCheck size={16} />
              </button>
            )}
            <ClientHubSwitch compact />
            <button className="icon-button" onClick={props.onLogout} title="退出登录" aria-label="退出登录">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
