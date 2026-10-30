import { useEffect, useState } from "react";
import {
  ArrowUpRight, ChevronDown, FolderGit2, Link2, LoaderCircle,
  MessageSquare, Network, Plus, RefreshCw, Search, Server, Settings2, SlidersHorizontal,
} from "lucide-react";
import { errorText, statusLabel } from "../../api";
import type { DevHost, Overview, Project, User } from "../../types";
import MobileCardDetails from "./MobileCardDetails";
import UserSelect from "./UserSelect";
import { useResourceView } from "./useResourceView";
import "../../styles/admin-resources.css";

interface Props {
  kind: "workspaces" | "connections";
  overview: Overview;
  users: User[] | null;
  selectedUserId: string;
  onSelectUser: (userId: string) => void;
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
  onNewHost: () => void;
  onEditHost: (host: DevHost) => void;
  onConnect: (host: DevHost) => Promise<void>;
  onRefresh: () => Promise<void>;
  refreshing?: boolean;
}

function ResourceStatus({ status }: { status: string }) {
  const tone = ["CONNECTED", "READY", "LOCAL", "WATCHING"].includes(status)
    ? "success" : status === "ERROR" ? "danger" : "";
  return <span className={`admin-status admin-resource-status ${tone}`}><i />{statusLabel(status)}</span>;
}

export default function ResourceManagement({ kind, overview, users, selectedUserId, onSelectUser, onOpenProject, onNewProject, onNewHost, onEditHost, onConnect, onRefresh, refreshing = false }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [expanded, setExpanded] = useState("");
  const [connectingId, setConnectingId] = useState("");
  const [error, setError] = useState("");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const { resources, loading, error: viewError, refresh: refreshView } = useResourceView(overview, selectedUserId, onRefresh);
  const readOnly = selectedUserId !== overview.user.id;
  const readOnlyNote = "其他用户的资源仅供查看，请切回当前账号执行操作";
  const scopeUsers = [overview.user, ...(users || []).filter((user) => user.id !== overview.user.id)];
  if (!scopeUsers.some((user) => user.id === selectedUserId)) scopeUsers.push(resources?.user || { ...overview.user, id: selectedUserId, username: "所选用户" });
  const projects = resources?.projects || [];
  const allHosts = resources?.hosts || [];
  const workspaces = kind === "workspaces";
  const hosts = allHosts.filter((host) => host.kind !== "local");
  const matching = (values: string[]) => values.join(" ").toLowerCase().includes(query.trim().toLowerCase());
  const filteredProjects = projects.filter((project) => {
    const host = allHosts.find((item) => item.id === project.dev_host_id);
    return matching([project.name, project.remote_path, host?.name || ""])
      && (status === "all" || project.sync_status === status);
  });
  const filteredHosts = hosts.filter((host) => matching([host.name, host.host, host.username])
    && (status === "all" || host.status === status));
  const statuses = [...new Set(workspaces ? projects.map((project) => project.sync_status) : hosts.map((host) => host.status))];
  const total = workspaces ? projects.length : hosts.length;
  const visible = workspaces ? filteredProjects.length : filteredHosts.length;

  useEffect(() => { setQuery(""); setStatus("all"); setExpanded(""); setError(""); }, [kind, selectedUserId]);

  async function connect(host: DevHost) {
    if (connectingId || readOnly || !resources || loading) return;
    setConnectingId(host.id);
    setError("");
    try { await onConnect(host); }
    catch (cause) { setError(errorText(cause)); }
    finally { setConnectingId(""); }
  }

  async function refresh() {
    if (refreshBusy || refreshing || loading) return;
    setRefreshBusy(true);
    setError("");
    try { await refreshView(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setRefreshBusy(false); }
  }

  return (
    <div className="admin-resource-page">
      <section className="admin-card admin-resource-inventory" aria-label={workspaces ? "Workspace 列表" : "开发机列表"} aria-busy={loading}>
        <div className="admin-resource-scope">
          <UserSelect className="admin-resource-view" value={selectedUserId} ariaLabel="资源视图" searchLabel="搜索资源所属用户"
            disabled={Boolean(connectingId)} onChange={onSelectUser} options={scopeUsers.map((user) => ({
              value: user.id, label: user.username, description: user.id === overview.user.id ? "当前账号" : user.role === "admin" ? "管理员" : "成员",
            }))} />
          <div className="admin-resource-summary-actions">
          <button type="button" className="icon-button" disabled={refreshBusy || refreshing || loading} onClick={() => void refresh()}
            aria-label={workspaces ? "刷新 Workspace 列表" : "刷新开发机列表"} title={workspaces ? "刷新 Workspace 列表" : "刷新开发机列表"}>
            <RefreshCw size={15} className={refreshBusy || refreshing || loading ? "spin" : ""} />
          </button>
          <button type="button" className="button button-primary button-small" disabled={readOnly || loading || !resources}
            title={readOnly ? readOnlyNote : undefined} onClick={workspaces ? onNewProject : onNewHost}>
            <Plus size={15} />{workspaces ? "添加 Workspace" : "添加开发机"}
          </button>
          </div>
        </div>
        <div className="admin-resource-toolbar">
          <label className="admin-resource-search"><Search size={15} /><input aria-label={workspaces ? "搜索 Workspace" : "搜索开发机"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={workspaces ? "搜索项目、路径或开发机…" : "搜索名称、主机或用户名…"} /></label>
          <label className="admin-resource-filter"><SlidersHorizontal size={14} /><select aria-label="筛选资源状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">所有状态</option>{statuses.map((value) => <option value={value} key={value}>{statusLabel(value)}</option>)}</select></label>
        </div>
        {(error || viewError) && <div className="inline-error admin-resource-error" role="alert">{error || viewError}</div>}
        {loading ? <div className="loading-state"><LoaderCircle size={20} className="spin" />正在加载资源…</div> : !resources ? null : visible === 0 ? (
          <div className="admin-resource-empty">
            <span>{workspaces ? <FolderGit2 size={26} /> : <Network size={26} />}</span>
            <h3>{total ? "没有符合条件的资源" : readOnly ? "该用户暂无资源" : workspaces ? "为项目准备一个工作空间" : "连接你的第一台开发机"}</h3>
            <p>{total ? "试试其他关键词，或清除当前筛选条件。" : readOnly ? "选择其他用户查看资源。" : workspaces ? "从本机目录或远程开发机开始，集中管理项目与会话。" : "添加 SSH 连接后，即可将远程项目带入工作台。"}</p>
            {(total > 0 || !readOnly) && <button className="button button-secondary button-small" onClick={total ? () => { setQuery(""); setStatus("all"); } : workspaces ? onNewProject : onNewHost}>{total ? "清除筛选" : workspaces ? "添加 Workspace" : "添加开发机"}<ArrowUpRight size={14} /></button>}
          </div>
        ) : workspaces ? (
          <div className="admin-resource-list">
            {filteredProjects.map((project) => {
              const host = allHosts.find((item) => item.id === project.dev_host_id);
              const count = resources.sessionCounts[project.id] || 0;
              return (
                <article className="admin-resource-project" key={project.id}>
                  <div className="admin-resource-project-main">
                    <span className="admin-resource-icon"><FolderGit2 size={19} /></span>
                    <div className="admin-resource-name"><strong>{project.name}</strong><code title={project.remote_path}>{project.remote_path}</code></div>
                    <div className="admin-resource-host-name"><Server size={13} /><span>{host?.name || "未关联开发机"}</span></div>
                    <span className="admin-resource-sessions" title={`${count} 个对话`}><MessageSquare size={13} />{count}</span>
                    <ResourceStatus status={project.sync_status} />
                    <button className="icon-button" onClick={() => setExpanded(expanded === project.id ? "" : project.id)} aria-expanded={expanded === project.id} aria-controls={`resource-${project.id}`} aria-label={`查看 ${project.name} 路径详情`}><ChevronDown size={15} className={expanded === project.id ? "admin-resource-rotated" : ""} /></button>
                    <button className="admin-resource-open" disabled={readOnly} onClick={() => onOpenProject(project)} title={readOnly ? readOnlyNote : `打开 ${project.name}`}><span>打开</span><ArrowUpRight size={15} /></button>
                  </div>
                  {expanded === project.id && <dl className="admin-resource-details" id={`resource-${project.id}`}><div><dt>项目目录</dt><dd><code>{project.remote_path}</code></dd></div><div><dt>本机路径</dt><dd><code>{project.local_path || "尚未建立"}</code></dd></div><div><dt>执行方式</dt><dd>{project.execution_mode || "待初始化"}</dd></div><div><dt>所属账号</dt><dd>{resources.user.username}</dd></div></dl>}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="admin-resource-connections">
            {filteredHosts.map((host) => {
              const projectCount = projects.filter((project) => project.dev_host_id === host.id).length;
              const connecting = connectingId === host.id;
              return (
                <article className="admin-resource-connection" key={host.id}>
                  <div className="admin-resource-connection-title"><span className="admin-resource-icon"><Server size={20} /></span><div className="admin-resource-name"><strong>{host.name}</strong><span>SSH · 远程开发环境</span></div><ResourceStatus status={host.status} /></div>
                  <MobileCardDetails label={`${host.name} 连接`} summary={<div className="admin-resource-connection-summary"><code title={`${host.username}@${host.host}:${host.port}`}>{host.username}@{host.host}</code><span>{projectCount} 个项目</span></div>}>
                    <dl className="admin-resource-connection-details"><div><dt>连接地址</dt><dd><code>{host.username}@{host.host}:{host.port}</code></dd></div><div><dt>跳板机</dt><dd>{host.jump_host ? <code>{host.jump_username || host.username}@{host.jump_host}:{host.jump_port || 22}</code> : "直连 · 无跳板机"}</dd></div><div><dt>关联项目</dt><dd>{projectCount} 个 Workspace</dd></div></dl>
                    <div className="admin-resource-connection-actions"><button className="button button-secondary button-small" disabled={connecting || readOnly} title={readOnly ? readOnlyNote : undefined} onClick={() => onEditHost(host)}><Settings2 size={13} />编辑连接</button><button className="button button-secondary button-small" disabled={Boolean(connectingId) || readOnly} title={readOnly ? readOnlyNote : undefined} onClick={() => void connect(host)}>{connecting ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} />}{connecting ? "正在连接…" : "测试连接"}</button></div>
                  </MobileCardDetails>
                </article>
              );
            })}
          </div>
        )}
        <div className="admin-resource-footer"><span>{resources ? `显示 ${visible} / ${total} 个${workspaces ? " Workspace" : "开发机"}` : loading ? "正在加载资源…" : "资源未加载"}</span><span>{readOnly ? "其他用户资源 · 只读视图" : workspaces ? "本机与远程项目统一管理" : "连接状态以最近一次检查为准"}</span></div>
      </section>
    </div>
  );
}
