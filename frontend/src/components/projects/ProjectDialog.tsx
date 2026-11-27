import { useEffect, useState, type FormEvent } from "react";
import { FolderPlus, LoaderCircle, Plus, ShieldCheck, WifiOff } from "lucide-react";
import { errorText, post } from "../../api";
import type { ClientProjectMode, DevHost, Overview, Project, SyncScan } from "../../types";
import { Modal } from "../Dialogs";
import {
  clientPlatformLabel,
  isClientHost,
  isClientHostOnline,
  isWindowsPlatform,
} from "../hosts/client-device";
import DirectoryCombobox, { isAbsoluteDirectoryPath } from "./DirectoryCombobox";
import SyncScanSummary from "./SyncScanSummary";
import "../../styles/client-devices.css";

interface Props {
  overview: Overview;
  initialHost?: DevHost;
  onClose: () => void;
  onCreated: (project: Project) => Promise<void>;
}

function normalizedPath(raw: string, allowWindows: boolean): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (allowWindows && /^[A-Za-z]:[\\/]+$/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}\\`;
  }
  const stripped = allowWindows ? trimmed.replace(/[\\/]+$/, "") : trimmed.replace(/\/+$/, "");
  if (stripped) return stripped;
  return "/";
}

function defaultProjectName(remotePath: string, allowWindows: boolean): string {
  return remotePath
    .split(allowWindows ? /[\\/]/ : "/")
    .filter((segment) => segment && !(allowWindows && /^[A-Za-z]:$/.test(segment)))
    .at(-1) || "";
}

function hostOptionLabel(host: DevHost): string {
  if (host.kind === "local") return `${host.name} · 管理员专用`;
  if (isClientHost(host)) {
    const platform = clientPlatformLabel(host.device?.platform);
    return `${host.name} · ${platform}（${isClientHostOnline(host) ? "在线" : "离线"}）`;
  }
  return `${host.name} · ${host.username}@${host.host}`;
}

export default function ProjectDialog({ overview, initialHost, onClose, onCreated }: Props) {
  const [hostId, setHostId] = useState(
    initialHost?.id || overview.hosts.find((host) => host.kind === "local")?.id || overview.hosts[0]?.id || "",
  );
  const [path, setPath] = useState("");
  const [source, setSource] = useState<"existing" | "new">("existing");
  const [pathMode, setPathMode] = useState<"auto" | "bwrap" | "symlink">("auto");
  const [clientMode, setClientMode] = useState<ClientProjectMode>("direct");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<SyncScan | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const selectedHost = overview.hosts.find((host) => host.id === hostId);
  const local = selectedHost?.kind === "local";
  const client = isClientHost(selectedHost);
  const clientOnline = client && isClientHostOnline(selectedHost);
  const windowsClient = client && isWindowsPlatform(selectedHost?.device?.platform);
  const remotePath = normalizedPath(path, windowsClient);
  const projectName = nameEdited ? name : defaultProjectName(remotePath, windowsClient);
  // Only the first sync of an existing SSH directory is scanned for large outputs.
  const needsScan = !local && !client && source === "existing";
  const scanPending = needsScan && !scan && !scanFailed;

  useEffect(() => {
    setScan(null);
    setScanFailed(false);
    setExcluded(new Set());
  }, [hostId, remotePath, source]);

  async function scanRemote() {
    try {
      const result = await post<SyncScan>(`/hosts/${hostId}/sync-scan`, { remotePath });
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if ((source === "existing" || local || client) && !isAbsoluteDirectoryPath(path, windowsClient)) {
      setError(windowsClient
        ? "请输入有效的 Windows 绝对路径（例如 C:\\Projects\\my-app 或 D:/work/demo）。"
        : client
          ? "请输入客户端本机的绝对路径（例如 /Users/name/project）。"
          : "请输入以 / 开头的绝对路径。");
      return;
    }
    setBusy(true);
    if (scanPending) {
      await scanRemote();
      setBusy(false);
      return;
    }
    try {
      const project = await post<Project>("/projects", {
        name: projectName.trim(),
        devHostId: hostId,
        source,
        ...((source === "existing" || local || client) ? { remotePath } : {}),
        ...(!local && !client && source === "existing" ? { pathMode } : {}),
        ...(client ? { clientMode } : {}),
        ...(needsScan && excluded.size ? { ignorePaths: [...excluded] } : {}),
      });
      onClose();
      await onCreated(project);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="创建项目"
      subtitle={
        local
          ? "直接在号池机上的项目目录中协作。"
          : client
            ? "在你的桌面客户端本机目录中直接协作或同步工作区。"
            : "把远程目录映射为独立的协作工作区。"
      }
      onClose={() => { if (!busy) onClose(); }}
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
            disabled={busy}
            onChange={(event) => {
              setHostId(event.target.value);
              setPath("");
              setError("");
            }}
            required
          >
            <option value="" disabled>选择开发机</option>
            {overview.hosts.map((host) => (
              <option key={host.id} value={host.id}>{hostOptionLabel(host)}</option>
            ))}
          </select>
        </label>
        {client && !clientOnline && (
          <div className="client-device-offline-hint" role="status">
            <WifiOff size={14} />
            <span>客户端离线，请在桌面客户端确认连接后再浏览目录或创建项目。</span>
          </div>
        )}
        <label>
          项目名称
          <input
            autoFocus
            value={projectName}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
            placeholder="给项目起一个名字，默认使用目录名"
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
            {local || client ? "打开已有项目" : "连接已有项目"}
          </button>
          <button
            type="button"
            className={source === "new" ? "active" : ""}
            aria-pressed={source === "new"}
            disabled={busy}
            onClick={() => setSource("new")}
          >
            {local || client ? "在本机新建项目" : "在远端新建项目"}
          </button>
        </div>
        {source === "existing" || local || client ? (
          <>
            <label>
              {local ? "本机目录" : client ? "客户端本机目录" : "远程目录"}
              <DirectoryCombobox
                key={hostId}
                hostId={hostId}
                value={path}
                onChange={setPath}
                allowWindows={windowsClient}
                isWindowsHost={windowsClient}
                hostOffline={client && !clientOnline}
                placeholder={
                  local
                    ? "号池机上的绝对路径"
                    : windowsClient
                      ? "例如：C:\\Projects\\my-app"
                      : client
                        ? "客户端本机绝对路径（如 /Users/...）"
                        : "开发机上的绝对路径"
                }
                disabled={busy}
              />
            </label>
            {client && (
              <div className="client-mode-group" role="radiogroup" aria-label="客户端运行模式">
                <span className="client-mode-label">客户端运行模式</span>
                <label className={`client-mode-option${clientMode === "direct" ? " selected" : ""}`}>
                  <input
                    type="radio"
                    name="clientMode"
                    value="direct"
                    checked={clientMode === "direct"}
                    disabled={busy}
                    onChange={() => setClientMode("direct")}
                  />
                  <span className="client-mode-copy">
                    <strong>
                      客户端直执
                      <span className="client-device-tag">默认推荐</span>
                    </strong>
                    <small>零镜像零同步，秒开使用，所有文件与命令均在本机直接执行。</small>
                  </span>
                </label>
                <label className={`client-mode-option${clientMode === "mirrored" ? " selected" : ""}`}>
                  <input
                    type="radio"
                    name="clientMode"
                    value="mirrored"
                    checked={clientMode === "mirrored"}
                    disabled={busy}
                    onChange={() => setClientMode("mirrored")}
                  />
                  <span className="client-mode-copy">
                    <strong>镜像同步</strong>
                    <small>双向同步至 Hub 镜像以使用 CLI 原生文件工具，仅命令回客户端执行。</small>
                  </span>
                </label>
              </div>
            )}
            {!local && !client && (
              <>
                <label>
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
                </p>
              </>
            )}
            {scan && <SyncScanSummary scan={scan} excluded={excluded} disabled={busy} onToggle={toggleExcluded} />}
            {(local || client) && source === "new" && <p className="form-hint">请输入要创建的新目录，父目录必须已存在。</p>}
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
              : client
                ? clientMode === "direct"
                  ? "零镜像零同步，秒开使用。所有文件读写与终端命令都在你的客户端本机直接执行，修改即时生效。"
                  : "源码双向同步至 Hub 镜像以便 CLI 使用原生文件工具，终端命令仍在你的客户端本机执行。"
                : "源码通过 Mutagen 双向同步，创建后在后台完成首次同步，可在侧栏查看进度。依赖与构建产物留在开发机，终端命令始终远程执行。"}
          </p>
        </div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button button-primary" disabled={busy || !hostId || (client && !clientOnline)}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            {busy
              ? local || (client && clientMode === "direct")
                ? "正在打开项目…"
                : scanPending
                  ? "正在扫描远端目录…"
                  : "正在创建项目…"
              : scanPending
                ? "扫描并继续"
                : "创建项目"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
