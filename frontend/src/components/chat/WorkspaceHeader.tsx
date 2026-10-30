import { useLayoutEffect, useRef, useState } from "react";
import { FolderOpen, Menu, PanelRightClose, PanelRightOpen } from "lucide-react";
import { isActive, statusLabel } from "../../api";
import type { Overview, Project, Session } from "../../types";
import ProjectPathSettings from "./ProjectPathSettings";

interface Props {
  overview: Overview;
  project?: Project;
  session?: Session;
  active: boolean;
  inspectorOpen: boolean;
  streamConnected: boolean;
  onSidebar: () => void;
  onInspector: () => void;
  onProjectRefresh: () => Promise<void>;
}

function FadingName({ children, className }: { children: string; className: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => setOverflowing(text.scrollWidth > text.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span ref={textRef} className={`fading-name ${className}`} data-overflow={overflowing} title={children}>
      {children}
    </span>
  );
}

export default function WorkspaceHeader(props: Props) {
  const { overview, project, session } = props;
  const host = overview.hosts.find((item) => item.id === project?.dev_host_id);
  const syncReady = project?.sync_status === "WATCHING" || project?.sync_status === "LOCAL";
  const hostConnected = !host || host.kind === "local" || host.status === "CONNECTED";
  const connectionState = !props.streamConnected ? "reconnecting"
    : host?.status === "ERROR" || project?.sync_status === "ERROR" ? "error"
    : !hostConnected || (project && !syncReady) ? "warning" : "connected";
  const connectionLabel = !props.streamConnected ? "正在重连"
    : !hostConnected ? statusLabel(host!.status)
    : project && !syncReady ? statusLabel(project.sync_status) : "实时连接";
  const connectionDetails = [
    props.streamConnected ? "工作台实时连接正常" : "工作台连接中断，正在重连",
    host && `${host.name}：${host.kind === "local" ? "本机" : statusLabel(host.status)}`,
    project && `项目：${statusLabel(project.sync_status)}`,
  ].filter(Boolean).join(" · ");

  return (
    <header className="workspace-header">
      <button className="icon-button mobile-only" onClick={props.onSidebar} aria-label="打开导航" title="打开导航">
        <Menu size={18} aria-hidden="true" />
      </button>
      <div className="workspace-context">
        <div className="breadcrumb">
          <span className="breadcrumb-project">
            <FolderOpen size={15} aria-hidden="true" />
            <FadingName className="breadcrumb-project-name">{project?.name || "工作台"}</FadingName>
          </span>
          {session && (
            <>
              <span className="breadcrumb-divider" aria-hidden="true">/</span>
              <strong title={session.title}>{session.title}</strong>
            </>
          )}
        </div>
        <span className={`connection-status ${connectionState}`} title={connectionDetails} role="status" aria-label={connectionDetails}>
          <span className="status-dot" aria-hidden="true" />
          {host && <FadingName className="connection-host">{host.name}</FadingName>}
          <span className="connection-label">{connectionLabel}</span>
        </span>
      </div>
      <div className="header-actions">
        {project && <ProjectPathSettings project={project} active={overview.sessions.some((item) => item.project_id === project.id && isActive(item.status)) || props.active} onRefresh={props.onProjectRefresh} />}
        <button
          className={`icon-button ${props.inspectorOpen ? "is-active" : ""}`}
          onClick={props.onInspector}
          aria-label={props.inspectorOpen ? "关闭工作区检查器" : "打开工作区检查器"}
          title="工作区检查器"
        >
          {props.inspectorOpen ? <PanelRightClose size={17} aria-hidden="true" /> : <PanelRightOpen size={17} aria-hidden="true" />}
        </button>
      </div>
    </header>
  );
}
