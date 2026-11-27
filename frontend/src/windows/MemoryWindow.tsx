import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useSiteSettings } from "../site/store";
import type { Overview } from "../types";
import type { Notice } from "../components/AppNotices";
import ProjectMemoryDialog from "../components/projects/ProjectMemoryDialog";
import { broadcastWindowEvent, subscribeWindowEvents } from "./channel";
import { closeCurrentWindow, focusMainWindow } from "./launcher";
import type { MemoryWindowTarget } from "./types";

interface Props {
  target: MemoryWindowTarget;
  overview: Overview;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
}

export default function MemoryWindow({ target, overview, onNotice }: Props) {
  const siteSettings = useSiteSettings();
  const [refreshTick, setRefreshTick] = useState(0);

  const project = overview.projects.find((item) => item.id === target.projectId);
  const titleName = project?.name || target.projectName || "项目记忆";

  useEffect(() => {
    document.title = `项目记忆 · ${titleName} — ${siteSettings.name}`;
  }, [titleName, siteSettings.name]);

  useEffect(() => {
    return subscribeWindowEvents((message) => {
      if (message.type === "memory-changed" && message.projectId === target.projectId) {
        setRefreshTick((value) => value + 1);
      }
    });
  }, [target.projectId]);

  if (!project) {
    return (
      <div className="detached-window-state">
        <AlertCircle size={24} />
        <strong>找不到对应项目</strong>
        <p>项目「{target.projectName || target.projectId}」可能已被移除或当前账号无权访问。</p>
        <div className="detached-window-state-actions">
          <button type="button" className="button button-secondary" onClick={() => focusMainWindow()}>
            回到主窗口
          </button>
          <button type="button" className="button button-ghost" onClick={() => closeCurrentWindow()}>
            关闭窗口
          </button>
        </div>
      </div>
    );
  }

  return (
    <ProjectMemoryDialog
      project={project}
      standalone
      refreshTick={refreshTick}
      onClose={() => closeCurrentWindow()}
      onFocusMain={() => focusMainWindow()}
      onNotice={onNotice}
      onChanged={() => broadcastWindowEvent({ type: "memory-changed", projectId: project.id })}
    />
  );
}
