import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ChevronRight,
  File,
  Folder,
  FolderPlus,
  LoaderCircle,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { api, errorText, formatBytes, post } from "../api";
import type { DevHost, FileEntry, Overview, SyncScan } from "../types";
import { Modal } from "./Dialogs";
export { default as HostDialog } from "./hosts/HostDialog";
interface CreateProps {
  overview: Overview;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function ProjectDialog({
  overview,
  initialHost,
  onClose,
  onCreated,
}: CreateProps & { initialHost?: DevHost }) {
  const [hostId, setHostId] = useState(
    initialHost?.id || overview.hosts.find((host) => host.kind === "local")?.id || overview.hosts[0]?.id || "",
  );
  const [path, setPath] = useState("");
  const [source, setSource] = useState<"existing" | "new">("existing");
  const [pathMode, setPathMode] = useState<"auto" | "bwrap" | "symlink">("auto");
  const [name, setName] = useState("");
  const [directories, setDirectories] = useState<FileEntry[] | null>(null);
  const [browserPath, setBrowserPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<SyncScan | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const local = overview.hosts.find((host) => host.id === hostId)?.kind === "local";
  // Only the first sync of an existing remote directory is scanned for large outputs.
  const needsScan = !local && source === "existing";
  const scanPending = needsScan && !scan && !scanFailed;
  const excludedBytes = scan?.entries
    .filter((entry) => excluded.has(entry.path))
    .reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;
  useEffect(() => {
    setScan(null);
    setScanFailed(false);
    setExcluded(new Set());
  }, [hostId, path, source]);
  async function scanRemote() {
    try {
      const result = await post<SyncScan>(`/hosts/${hostId}/sync-scan`, { remotePath: path });
      setScan(result);
      setExcluded(new Set(result.entries.filter((entry) => entry.tracked === false).map((entry) => entry.path)));
    } catch (cause) {
      setScanFailed(true);
      setError(`体积扫描失败：${errorText(cause)}。可直接创建项目，不添加排除规则。`);
    }
  }
  function toggleExcluded(entryPath: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }
  async function browse(target = path || "/") {
    if (!hostId) return;
    setBrowsing(true);
    setError("");
    try {
      const result = await api<{ path: string; entries: FileEntry[] }>(
        `/hosts/${hostId}/directories?path=${encodeURIComponent(target)}`,
      );
      setDirectories(result.entries);
      setBrowserPath(result.path);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBrowsing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    if (scanPending) {
      await scanRemote();
      setBusy(false);
      return;
    }
    try {
      await post("/projects", {
        name,
        devHostId: hostId,
        source,
        ...((source === "existing" || local) ? { remotePath: path } : {}),
        ...(!local && source === "existing" ? { pathMode } : {}),
        ...(needsScan && excluded.size ? { ignorePaths: [...excluded] } : {}),
      });
      await onCreated();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="创建项目"
      subtitle={local ? "直接在号池机上的项目目录中协作。" : "把远程目录映射为独立的协作工作区。"}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="form-section-icon">
          <FolderPlus size={22} />
          <span>新的项目空间</span>
        </div>
        <label>
          开发机
          <select
            value={hostId}
            onChange={(event) => {
              setHostId(event.target.value);
              setDirectories(null);
              setPath("");
            }}
            required
          >
            <option value="" disabled>
              选择开发机
            </option>
            {overview.hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.kind === "local" ? `${host.name} · 管理员专用` : `${host.name} · ${host.username}@${host.host}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="给项目起一个名字"
            maxLength={100}
            required
          />
        </label>
        <div className="segmented-control" aria-label="项目来源">
          <button
            type="button"
            className={source === "existing" ? "active" : ""}
            aria-pressed={source === "existing"}
            disabled={busy}
            onClick={() => setSource("existing")}
          >
            {local ? "打开已有项目" : "连接已有项目"}
          </button>
          <button
            type="button"
            className={source === "new" ? "active" : ""}
            aria-pressed={source === "new"}
            disabled={busy}
            onClick={() => {
              setSource("new");
              setDirectories(null);
            }}
          >
            {local ? "在本机新建项目" : "在远端新建项目"}
          </button>
        </div>
        {source === "existing" || local ? (
          <>
            <label>
              {local ? "本机目录" : "远程目录"}
              <div className="input-with-button">
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={local ? "号池机上的绝对路径" : "开发机上的绝对路径"}
                  required
                  pattern="/.*"
                />
                <button
                  type="button"
                  disabled={browsing || !hostId}
                  onClick={() => void browse()}
                >
                  {browsing ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Folder size={15} />
                  )}
                  浏览
                </button>
              </div>
            </label>
            {directories && (
              <div className="directory-picker">
                <div className="directory-picker-heading">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() =>
                      void browse(
                        browserPath.split("/").slice(0, -1).join("/") || "/",
                      )
                    }
                    aria-label="上一级目录"
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <span>{browserPath}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setPath(browserPath);
                      if (!name)
                        setName(
                          browserPath.split("/").filter(Boolean).at(-1) ||
                            "project",
                        );
                      setDirectories(null);
                    }}
                  >
                    选择此目录
                  </button>
                </div>
                <div>
                  {directories.length ? (
                    directories.map((entry) => (
                      <button
                        type="button"
                        key={entry.path}
                        onClick={() => void browse(entry.path)}
                      >
                        <Folder size={14} />
                        <span>{entry.name}</span>
                        <ChevronRight size={13} />
                      </button>
                    ))
                  ) : (
                    <p>没有子目录</p>
                  )}
                </div>
              </div>
            )}
            {!local && <><label>
              路径统一方式
              <select
                value={pathMode}
                disabled={busy}
                onChange={(event) => setPathMode(event.target.value as typeof pathMode)}
              >
                <option value="auto">自动：优先 bwrap，缺少时使用软链接</option>
                <option value="bwrap">bwrap 挂载（需远端支持）</option>
                <option value="symlink">软链接</option>
              </select>
            </label>
            <p className="form-hint">
              {pathMode === "symlink"
                ? "软链接兼容性较低，realpath、pwd -P 等仍可能显示实际目录。"
                : pathMode === "bwrap"
                  ? "请先在开发机安装并启用 bwrap。系统会验证挂载能力，不可用时保留错误供你处理。"
                  : "推荐在开发机安装 bwrap，让命令使用与本地一致的路径。软链接降级时，realpath 等仍可能显示实际目录。"}
            </p></>}
            {scan && (
              <div className="sync-scan">
                <div className="sync-scan-heading">
                  <span>首次同步约 {formatBytes(Math.max(0, scan.totalBytes - excludedBytes))}</span>
                  <span>
                    {excluded.size ? `已排除 ${formatBytes(excludedBytes)} · ` : ""}共 {scan.totalFiles} 个文件
                  </span>
                </div>
                {scan.entries.length ? (
                  <div className="sync-scan-list">
                    {scan.entries.map((entry) => (
                      <label
                        key={entry.path}
                        title={entry.type === "directory" ? `${entry.files} 个文件` : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={excluded.has(entry.path)}
                          disabled={busy}
                          onChange={() => toggleExcluded(entry.path)}
                        />
                        {entry.type === "directory" ? <Folder size={14} /> : <File size={14} />}
                        <span className="sync-scan-path">
                          {entry.path}
                          {entry.type === "directory" ? "/" : ""}
                        </span>
                        {entry.tracked && <span className="sync-scan-tag">Git 跟踪</span>}
                        <span className="sync-scan-size">{formatBytes(entry.bytes)}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p>未发现超过 1 MB 的目录或文件，可直接创建。</p>
                )}
                <p className="form-hint">
                  勾选的路径将写入远端项目根目录的 .clinavatignore（不存在时自动创建），不再同步到号池机；之后可编辑该文件并「立即同步」生效。
                  {scan.truncated && "文件过多，统计只覆盖了部分文件。"}
                </p>
              </div>
            )}
            {local && source === "new" && <p className="form-hint">请输入要创建的新目录，父目录必须已存在。</p>}
          </>
        ) : (
          <div className="info-note">
            <FolderPlus size={16} />
            <p>在开发机和号池机的相同路径下创建空项目目录，目录名由系统生成，无需安装 bwrap。</p>
          </div>
        )}
        <div className="info-note">
          <ShieldCheck size={16} />
          <p>
            {local
              ? "CLI 与终端直接在所选目录运行，文件修改立即生效。"
              : "源码通过 Mutagen 双向同步。依赖与构建产物留在开发机，终端命令始终远程执行。"}
          </p>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-ghost"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="button button-primary" disabled={busy || !hostId}>
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Plus size={15} />
            )}
            {busy
              ? local
                ? "正在打开项目…"
                : scanPending
                  ? "正在扫描远端目录…"
                  : "正在创建和同步…"
              : scanPending
                ? "扫描并继续"
                : "创建项目"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
