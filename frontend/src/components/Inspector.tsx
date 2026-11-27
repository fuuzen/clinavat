import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Files,
  Folder,
  FolderCheck,
  FolderSync,
  GitBranch,
  GitCompareArrows,
  Laptop,
  Link2Off,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
  WifiOff,
  X,
} from "lucide-react";
import { api, errorText, formatBytes, post } from "../api";
import { hasMultiWindowSupport, useClientShell } from "../client";
import type { DevHost, FileEntry, GitState, Project, ProjectUsage, SkippedLinks } from "../types";
import { broadcastWindowEvent } from "../windows/channel";
import { openDetachedWindow } from "../windows/launcher";
import { isClientDirectProject, isClientHost, isClientHostOnline } from "./hosts/client-device";
import SkippedLinksDialog from "./projects/SkippedLinksDialog";
import SyncRulesDialog from "./projects/SyncRulesDialog";
import WorktreeSetupDialog from "./projects/WorktreeSetupDialog";
import FileBrowser from "./workspace/FileBrowser";
import UploadStatus from "./workspace/UploadStatus";
import { useUploads } from "./workspace/useUploads";
const TerminalView = lazy(() => import("./TerminalView"));
const FilePreview = lazy(() => import("./preview/FilePreview"));

function parseSkippedLinks(value: string | null | undefined): SkippedLinks | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as SkippedLinks;
  } catch {
    return null;
  }
}

export type InspectorTabRequest =
  | { tab: "changes"; id: number }
  | { tab: "files"; path: string; id: number };

interface Props {
  tabRequest?: InspectorTabRequest;
  project?: Project;
  host?: DevHost;
  refresh: number;
  onClose: () => void;
  onRefresh: () => void;
}

export default function Inspector({
  project,
  host,
  refresh,
  onClose,
  onRefresh,
  tabRequest,
}: Props) {
  const [tab, setTab] = useState<"files" | "changes" | "terminal">("files");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewReloads, setPreviewReloads] = useState(0);
  const [git, setGit] = useState<GitState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [rulesDialog, setRulesDialog] = useState<{ append: string[] } | null>(null);
  const [worktreeDialog, setWorktreeDialog] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const clientShell = useClientShell();
  const multiWindow = hasMultiWindowSupport(clientShell);
  const projectId = project?.id;
  const skippedLinks = useMemo(() => parseSkippedLinks(project?.sync_skipped_links), [project?.sync_skipped_links]);
  const skippedCount = skippedLinks ? skippedLinks.links.length + skippedLinks.more : 0;
  const isClient = isClientHost(host);
  const clientOnline = isClient && isClientHostOnline(host);
  const clientDirect = isClientDirectProject(project, host);
  const usesMirror = !!project && project.execution_mode !== "local" && !clientDirect;
  const showSyncAction = !!project && (
    clientDirect
      ? project.sync_status === "ERROR"
      : (project.execution_mode !== "local" || project.sync_status === "ERROR")
  );
  const loadUsage = useCallback(async () => {
    if (!projectId || clientDirect) return;
    try {
      const result = await api<ProjectUsage>(`/projects/${projectId}/usage`);
      if (result.mirrorBytes !== null) setUsage(result);
    } catch {
      // Disk usage is informational; failures leave the footer without it.
    }
  }, [projectId, clientDirect]);
  useEffect(() => {
    setUsage(null);
    setRulesDialog(null);
    setLinksOpen(false);
  }, [projectId]);
  useEffect(() => {
    void loadUsage();
  }, [loadUsage, refresh, project?.sync_status]);
  useEffect(() => {
    setPath("");
    setSelected(null);
    setGit(null);
  }, [project?.id]);
  const load = useCallback(async () => {
    if (!project || tab === "terminal") return;
    setBusy(true);
    setError("");
    try {
      if (tab === "files") {
        const result = await api<{ entries: FileEntry[] }>(
          `/projects/${project.id}/files?path=${encodeURIComponent(path)}`,
        );
        setFiles(result.entries);
      } else setGit(await api<GitState>(`/projects/${project.id}/git`));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [project, tab, path]);
  useEffect(() => {
    void load();
  }, [load, refresh]);
  const uploads = useUploads(projectId, () => void load());
  const uploading = !!uploads.progress?.running;
  useEffect(() => {
    if (!editorDirty && !uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty, uploading]);
  // Leaving the files tab unmounts the editor; closing the panel also stops uploads.
  const confirmDiscard = () => !editorDirty || window.confirm("文件有未保存的修改，确定放弃吗？");
  const switchTab = (next: typeof tab) => {
    if (next !== tab && confirmDiscard()) setTab(next);
  };
  useEffect(() => {
    if (!tabRequest || !confirmDiscard()) return;
    setTab(tabRequest.tab);
    if (tabRequest.tab === "files") {
      setPath(tabRequest.path.split("/").slice(0, -1).join("/"));
      setSelected(tabRequest.path);
    }
  }, [tabRequest]);
  const close = () => {
    if (confirmDiscard() && (!uploading || window.confirm("文件仍在上传，关闭工作区会中断上传。确定关闭吗？"))) onClose();
  };
  function openFile(entry: FileEntry) {
    if (entry.type === "directory") setPath(entry.path);
    setSelected(entry.type === "file" ? entry.path : null);
  }
  const openLinkedFile = useCallback((target: string) => {
    setPath(target.split("/").slice(0, -1).join("/"));
    setSelected(target);
  }, []);
  const openDetachedPreview = useCallback(
    (filePath: string, fallback: () => void) => {
      if (!project) return;
      openDetachedWindow(
        { kind: "preview", projectId: project.id, path: filePath, projectName: project.name },
        { shell: clientShell, onFallback: fallback },
      );
    },
    [project, clientShell],
  );
  async function sync() {
    if (!project) return;
    setSyncing(true);
    setError("");
    try {
      await post(`/projects/${project.id}/sync`);
      onRefresh();
      void load();
      void loadUsage();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSyncing(false);
    }
  }
  const diff = git?.diff || "";
  const additions = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diff
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return (
    <aside className="inspector">
      <header className="inspector-header">
        <span>工作区</span>
        <div>
          <button
            className="inspector-refresh"
            onClick={() => {
              setPreviewReloads((count) => count + 1);
              void load();
            }}
            disabled={busy || !project}
            aria-label="刷新工作区"
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />
            刷新
          </button>
          <button
            className="icon-button"
            onClick={close}
            aria-label="关闭工作区"
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="inspector-tabs">
        <button
          className={tab === "files" ? "active" : ""}
          onClick={() => switchTab("files")}
        >
          <Files size={14} />
          文件
        </button>
        <button
          className={tab === "changes" ? "active" : ""}
          onClick={() => switchTab("changes")}
        >
          <GitCompareArrows size={14} />
          变更
        </button>
        <button
          className={tab === "terminal" ? "active" : ""}
          onClick={() => switchTab("terminal")}
        >
          <TerminalSquare size={14} />
          终端
        </button>
      </div>
      {!project ? (
        <div className="inspector-empty">
          <Folder size={30} />
          <strong>为灵感选一个落点</strong>
          <p>
            选择或创建项目后，
            <br />
            在这里浏览文件、审阅变更。
          </p>
        </div>
      ) : (
        <>
          <div className="inspector-project">
            <Folder size={14} />
            <strong>{project.name}</strong>
          </div>
          {isClient && !clientOnline && (
            <div className="inspector-error" role="status">
              <span><WifiOff size={13} /> 客户端离线，请在桌面客户端确认连接</span>
            </div>
          )}
          {error && (
            <div className="inspector-error">
              {error}
              <button onClick={() => void load()}>重试</button>
            </div>
          )}
          {tab === "terminal" ? (
            <Suspense
              fallback={
                <div className="loading-state">
                  <LoaderCircle size={18} className="spin" />
                </div>
              }
            >
              <TerminalView key={project.id} projectId={project.id} />
            </Suspense>
          ) : tab === "files" ? (
            <div className="file-browser">
              {selected ? (
                <Suspense
                  fallback={
                    <div className="loading-state">
                      <LoaderCircle size={18} className="spin" />
                    </div>
                  }
                >
                  <FilePreview
                    projectId={project.id}
                    projectName={project.name}
                    path={selected}
                    refresh={refresh + previewReloads}
                    onBack={() => setSelected(null)}
                    onOpen={openLinkedFile}
                    onDirtyChange={setEditorDirty}
                    onSaved={(saved) => {
                      broadcastWindowEvent({
                        type: "file-saved",
                        projectId: project.id,
                        path: saved.path,
                        etag: saved.etag,
                      });
                    }}
                    onDetach={
                      multiWindow
                        ? (fallback) => openDetachedPreview(selected, fallback)
                        : undefined
                    }
                  />
                </Suspense>
              ) : (
                <FileBrowser
                  path={path}
                  entries={files}
                  busy={busy}
                  uploading={uploading}
                  syncedMirror={usesMirror}
                  onNavigate={setPath}
                  onOpen={openFile}
                  onOpenDetached={
                    multiWindow
                      ? (entry) => openDetachedPreview(entry.path, () => openFile(entry))
                      : undefined
                  }
                  onUpload={(picked) => void uploads.start(path, picked)}
                />
              )}
              {uploads.progress && (
                <UploadStatus progress={uploads.progress} onCancel={uploads.cancel} onDismiss={uploads.dismiss} />
              )}
            </div>
          ) : (
            <div className="git-view">
              {busy ? (
                <div className="loading-state">
                  <LoaderCircle size={18} className="spin" />
                </div>
              ) : (
                git && (
                  <>
                    <div className="git-summary">
                      <span>
                        <GitBranch size={14} />
                        {git.branch || "未检出分支"}
                      </span>
                      <span className="diff-stats">
                        <i>+{additions}</i>
                        <b>−{deletions}</b>
                      </span>
                    </div>
                    {!git.status && !git.diff ? (
                      <div className="inspector-empty">
                        <GitCompareArrows size={28} />
                        <strong>工作区干干净净</strong>
                        <p>新的代码变更会出现在这里。</p>
                      </div>
                    ) : (
                      <>
                        <pre className="git-status">{git.status}</pre>
                        <div className="diff-preview">
                          {diff ? (
                            diff.split("\n").map((line, index) => (
                              <div
                                key={index}
                                className={
                                  line.startsWith("+") &&
                                  !line.startsWith("+++")
                                    ? "diff-addition"
                                    : line.startsWith("-") &&
                                        !line.startsWith("---")
                                      ? "diff-deletion"
                                      : line.startsWith("@@")
                                        ? "diff-hunk"
                                        : line.startsWith("diff ")
                                          ? "diff-file"
                                          : ""
                                }
                              >
                                {line || " "}
                              </div>
                            ))
                          ) : (
                            <p className="muted small-text">
                              无文本差异可预览。未跟踪文件请在文件页查看。
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )
              )}
            </div>
          )}
          {(usage || showSyncAction || clientDirect) && (
            <footer className="inspector-footer">
              {clientDirect && (
                <span className="inspector-usage" title="零镜像零同步，文件与命令直接在客户端本机执行">
                  <Laptop size={12} /> 本机直执（实时）
                </span>
              )}
              {usesMirror && usage && (
                <span className="inspector-usage" title="号池机上本项目同步镜像占用的磁盘空间">
                  镜像 {formatBytes(usage.mirrorBytes ?? 0)}
                </span>
              )}
              {usesMirror && skippedLinks && skippedCount > 0 && (
                <button className="inspector-skipped-links" onClick={() => setLinksOpen(true)} title="查看同步时跳过的软链接">
                  <Link2Off size={12} />
                  {skippedCount} 个软链接未同步
                </button>
              )}
              {usesMirror && (
                <button
                  disabled={syncing || project.sync_status === "CREATING" || (isClient && !clientOnline)}
                  onClick={() => setRulesDialog({ append: [] })}
                  title={project.sync_status === "CREATING" ? "同步完成后可用" : "查看和修改本项目的同步排除规则"}
                >
                  <ListFilter size={12} />
                  排除规则
                </button>
              )}
              {!project.parent_project_id && (
                <button onClick={() => setWorktreeDialog(true)} title="子智能体 worktree 的初始化命令">
                  <GitBranch size={12} />
                  Worktree
                </button>
              )}
              {showSyncAction && (
                <button
                  disabled={syncing || project.sync_status === "CREATING" || (isClient && !clientOnline)}
                  onClick={() => void sync()}
                  title={
                    isClient && !clientOnline
                      ? "客户端离线，请在桌面客户端确认连接"
                      : project.execution_mode === "local" || clientDirect
                        ? "检查本机目录是否可用"
                        : project.sync_status === "CREATING" ? "同步完成后可用" : "强制同步"
                  }
                >
                  {syncing ? (
                    <LoaderCircle size={12} className="spin" />
                  ) : project.execution_mode === "local" || clientDirect ? (
                    <FolderCheck size={12} />
                  ) : (
                    <FolderSync size={12} />
                  )}
                  {project.execution_mode === "local" || clientDirect
                    ? syncing ? "检查中" : "检查目录"
                    : syncing ? "同步中" : "立即同步"}
                </button>
              )}
            </footer>
          )}
          {linksOpen && project && skippedLinks && (
            <SkippedLinksDialog
              project={project}
              skipped={skippedLinks}
              onClose={() => setLinksOpen(false)}
              onExclude={(paths) => {
                setLinksOpen(false);
                setRulesDialog({ append: paths });
              }}
            />
          )}
          {rulesDialog && project && (
            <SyncRulesDialog project={project} append={rulesDialog.append} onClose={() => setRulesDialog(null)} onSaved={onRefresh} />
          )}
          {worktreeDialog && project && <WorktreeSetupDialog project={project} onClose={() => setWorktreeDialog(false)} onSaved={onRefresh} />}
        </>
      )}
    </aside>
  );
}
