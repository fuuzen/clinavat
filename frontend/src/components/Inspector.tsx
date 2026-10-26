import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  File,
  FileCode2,
  Files,
  Folder,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { api, errorText, post, statusLabel } from "../api";
import type { FileEntry, GitState, Project } from "../types";
const TerminalView = lazy(() => import("./TerminalView"));

interface Props {
  project?: Project;
  refresh: number;
  onClose: () => void;
  onRefresh: () => void;
}

export default function Inspector({
  project,
  refresh,
  onClose,
  onRefresh,
}: Props) {
  const [tab, setTab] = useState<"files" | "changes" | "terminal">("files");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [git, setGit] = useState<GitState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
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
  async function openFile(entry: FileEntry) {
    if (entry.type === "directory") {
      setPath(entry.path);
      setSelected(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      setSelected(
        await api<{ path: string; content: string }>(
          `/projects/${project!.id}/file?path=${encodeURIComponent(entry.path)}`,
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    if (!project) return;
    setSyncing(true);
    setError("");
    try {
      await post(`/projects/${project.id}/sync`);
      onRefresh();
      void load();
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
            className="icon-button"
            onClick={() => void load()}
            disabled={busy || !project}
            aria-label="刷新工作区"
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭工作区"
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="inspector-tabs">
        <button
          className={tab === "files" ? "active" : ""}
          onClick={() => setTab("files")}
        >
          <Files size={14} />
          文件
        </button>
        <button
          className={tab === "changes" ? "active" : ""}
          onClick={() => setTab("changes")}
        >
          <GitCompareArrows size={14} />
          变更
        </button>
        <button
          className={tab === "terminal" ? "active" : ""}
          onClick={() => setTab("terminal")}
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
            <span
              title={statusLabel(project.sync_status)}
              className={`status-dot ${["WATCHING", "READY"].includes(project.sync_status) ? "online" : ""}`}
            />
          </div>
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
                <>
                  <div className="file-breadcrumb">
                    <button
                      className="icon-button"
                      onClick={() => setSelected(null)}
                      aria-label="返回文件列表"
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <FileCode2 size={14} />
                    <span title={selected.path}>{selected.path}</span>
                  </div>
                  <div className="file-preview">
                    <pre>
                      <code>{selected.content}</code>
                    </pre>
                  </div>
                </>
              ) : (
                <>
                  <div className="file-breadcrumb">
                    {path ? (
                      <button
                        className="icon-button"
                        onClick={() =>
                          setPath(path.split("/").slice(0, -1).join("/"))
                        }
                        aria-label="上一级目录"
                      >
                        <ArrowLeft size={14} />
                      </button>
                    ) : (
                      <ChevronRight size={13} />
                    )}
                    <span title={path}>{path || "项目根目录"}</span>
                    <span className="file-count">{files.length}</span>
                  </div>
                  {busy ? (
                    <div className="loading-state">
                      <LoaderCircle size={18} className="spin" />
                    </div>
                  ) : files.length === 0 ? (
                    <div className="inspector-empty small">
                      <Folder size={25} />
                      <p>
                        这个目录暂时没有文件。
                        <br />
                        首次同步可能需要一些时间。
                      </p>
                    </div>
                  ) : (
                    <div className="file-list">
                      {[...files]
                        .sort((a, b) =>
                          a.type === b.type
                            ? a.name.localeCompare(b.name)
                            : a.type === "directory"
                              ? -1
                              : 1,
                        )
                        .map((entry) => (
                          <button
                            key={entry.path}
                            onClick={() => void openFile(entry)}
                          >
                            {entry.type === "directory" ? (
                              <Folder size={15} className="folder-icon" />
                            ) : (
                              <File size={14} />
                            )}
                            <span>{entry.name}</span>
                            {entry.type === "directory" && (
                              <ChevronRight size={12} />
                            )}
                          </button>
                        ))}
                    </div>
                  )}
                </>
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
          <footer className="inspector-footer">
            <span>
              <span
                className={`status-dot ${["WATCHING", "READY"].includes(project.sync_status) ? "online" : ""}`}
              />
              {statusLabel(project.sync_status)}
            </span>
            <button
              disabled={syncing}
              onClick={() => void sync()}
              title="强制同步"
            >
              <RefreshCw size={12} className={syncing ? "spin" : ""} />
              {syncing ? "同步中" : "立即同步"}
            </button>
          </footer>
        </>
      )}
    </aside>
  );
}
