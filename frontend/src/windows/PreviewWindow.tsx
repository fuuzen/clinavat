import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useSiteSettings } from "../site/store";
import type { Overview } from "../types";
import type { Notice } from "../components/AppNotices";
import { fileName, type FileMeta } from "../components/preview/fileKinds";
import { broadcastWindowEvent, subscribeWindowEvents } from "./channel";
import { canUseMultiWindow, closeCurrentWindow, focusMainWindow, openDetachedWindow } from "./launcher";
import { buildDetachedWindowUrl, type PreviewWindowTarget } from "./types";

const FilePreview = lazy(() => import("../components/preview/FilePreview"));

interface Props {
  target: PreviewWindowTarget;
  overview: Overview;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
}

export default function PreviewWindow({ target, overview, onNotice }: Props) {
  const siteSettings = useSiteSettings();
  const [currentPath, setCurrentPath] = useState(target.path);
  const [refreshTick, setRefreshTick] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);

  const project = overview.projects.find((item) => item.id === target.projectId);
  const projectName = project?.name || target.projectName || "工作区";

  useEffect(() => {
    setCurrentPath(target.path);
  }, [target.path]);

  useEffect(() => {
    document.title = `${fileName(currentPath)} — ${projectName} · ${siteSettings.name}`;
  }, [currentPath, projectName, siteSettings.name]);

  useEffect(() => {
    if (!editorDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty]);

  useEffect(() => {
    return subscribeWindowEvents((message) => {
      if (
        message.type === "file-saved" &&
        message.projectId === target.projectId &&
        message.path === currentPath
      ) {
        setRefreshTick((value) => value + 1);
      }
    });
  }, [target.projectId, currentPath]);

  const handleOpenLinked = useCallback(
    (nextPath: string) => {
      const normalized = nextPath.trim();
      if (!normalized || normalized === currentPath) return;
      const switchInPlace = () => {
        if (editorDirty && !window.confirm("文件有未保存的修改，确定切换文件吗？")) return;
        setCurrentPath(normalized);
        const nextUrl = buildDetachedWindowUrl({
          kind: "preview",
          projectId: target.projectId,
          path: normalized,
          projectName,
        });
        window.history.replaceState(null, "", nextUrl);
      };
      if (canUseMultiWindow()) {
        // Keep each detached window's native label bound to its original file; open/focus target file separately.
        openDetachedWindow(
          { kind: "preview", projectId: target.projectId, path: normalized, projectName },
          { onFallback: switchInPlace },
        );
        return;
      }
      switchInPlace();
    },
    [currentPath, editorDirty, target.projectId, projectName],
  );

  const handleSaved = useCallback(
    (saved: FileMeta) => {
      broadcastWindowEvent({
        type: "file-saved",
        projectId: target.projectId,
        path: saved.path,
        etag: saved.etag,
      });
      onNotice("已保存并同步到主窗口", "success");
    },
    [target.projectId, onNotice],
  );

  const handleLocateInMain = useCallback(() => {
    broadcastWindowEvent({
      type: "locate-file",
      projectId: target.projectId,
      path: currentPath,
    });
    focusMainWindow();
  }, [target.projectId, currentPath]);

  return (
    <div className="detached-preview-container">
      <Suspense
        fallback={
          <div className="detached-window-state">
            <LoaderCircle size={20} className="spin" />
            <span>正在加载文件预览…</span>
          </div>
        }
      >
        <FilePreview
          projectId={target.projectId}
          projectName={projectName}
          path={currentPath}
          refresh={refreshTick}
          standalone
          onBack={() => closeCurrentWindow()}
          onOpen={handleOpenLinked}
          onDirtyChange={setEditorDirty}
          onSaved={handleSaved}
          onLocateInMain={handleLocateInMain}
        />
      </Suspense>
    </div>
  );
}
