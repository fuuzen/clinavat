import { useEffect, useState, type FormEvent } from "react";
import { CircleHelp, Container, FolderCheck, FolderSync, Laptop, Link2, LoaderCircle } from "lucide-react";
import { api, errorText } from "../../api";
import type { ClientProjectMode, DevHost, Project } from "../../types";
import { Modal } from "../Dialogs";
import { clientProjectModeOf, isClientHost, isClientHostOnline } from "../hosts/client-device";
import "../../styles/client-devices.css";

interface Props {
  project: Project;
  host?: DevHost;
  active: boolean;
  onRefresh: () => Promise<void>;
  onNotice?: (message: string, kind?: "error" | "success") => void;
}

const executionLabels = {
  local: "本机目录",
  direct: "同路径",
  bwrap: "bwrap 挂载",
  symlink: "软链接",
  client: "客户端执行",
};

export default function ProjectPathSettings({ project, host, active, onRefresh, onNotice }: Props) {
  const [open, setOpen] = useState(false);
  const [pathMode, setPathMode] = useState("auto");
  const [clientMode, setClientMode] = useState<ClientProjectMode>("direct");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isClient = isClientHost(host);
  const clientOnline = isClient && isClientHostOnline(host);
  const currentClientMode = clientProjectModeOf(project, host) ?? "direct";
  const direct = !isClient && project.path_mode === "direct";
  const local = !isClient && project.execution_mode === "local";
  const executionLabel = isClient
    ? currentClientMode === "direct" ? "本机直执" : "镜像同步"
    : project.execution_mode ? executionLabels[project.execution_mode] : "路径未就绪";
  const PathIcon = isClient
    ? (currentClientMode === "direct" ? Laptop : FolderSync)
    : local ? Laptop
    : project.execution_mode === "direct" ? FolderCheck
    : project.execution_mode === "bwrap" ? Container
    : project.execution_mode === "symlink" ? Link2 : CircleHelp;
  const buttonTone = isClient
    ? (currentClientMode === "direct" ? "local" : "bwrap")
    : (project.execution_mode || "pending");

  useEffect(() => { setOpen(false); }, [project.id]);

  function showSettings() {
    setPathMode(direct ? "auto" : project.path_mode || "auto");
    setClientMode(currentClientMode);
    setError("");
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isClient) {
        const updated = await api<Project>(`/projects/${project.id}`, {
          method: "PATCH",
          body: JSON.stringify({ clientMode }),
        });
        setOpen(false);
        if (updated.sync_status === "CREATING" || (currentClientMode === "direct" && clientMode === "mirrored")) {
          onNotice?.("已切换为镜像同步模式，正在后台同步项目文件", "success");
        } else {
          onNotice?.(clientMode === "direct" ? "已切换为客户端直执模式" : "已更新客户端运行模式", "success");
        }
      } else {
        await api(`/projects/${project.id}`, {
          method: "PATCH",
          body: JSON.stringify({ pathMode }),
        });
        setOpen(false);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await onRefresh().catch(() => undefined);
      setSaving(false);
    }
  }

  const clientUnchanged = isClient && clientMode === currentClientMode;
  const requiresOnlineForSwitch = isClient && clientMode === "mirrored" && currentClientMode !== "mirrored";

  return <>
    <button
      className={`path-mode-button path-mode-${buttonTone}`}
      onClick={showSettings}
      title={
        isClient
          ? `${currentClientMode === "direct" ? "本机直执（实时）" : "镜像同步"}：${project.remote_path}，点击查看或切换模式`
          : local
            ? `本机工作目录：${project.local_path}`
            : `路径统一方式：${executionLabel}，点击查看设置`
      }
      aria-label={`项目路径设置：${executionLabel}`}
    >
      <PathIcon size={14} aria-hidden="true" />
      <span className="path-mode-label">{executionLabel}</span>
    </button>
    {open && <Modal title={isClient ? "客户端项目模式" : "项目路径"} subtitle={project.name} onClose={() => { if (!saving) setOpen(false); }}>
      <form className="modal-form" onSubmit={save}>
        {isClient ? (
          <>
            <label>客户端本机目录<input value={project.remote_path} readOnly /></label>
            {currentClientMode === "mirrored" && project.local_path && (
              <label>Hub 镜像目录<input value={project.local_path} readOnly /></label>
            )}
            <div className="client-mode-group" role="radiogroup" aria-label="客户端运行模式">
              <span className="client-mode-label">运行模式</span>
              <label className={`client-mode-option${clientMode === "direct" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="editClientMode"
                  value="direct"
                  checked={clientMode === "direct"}
                  disabled={saving || active}
                  onChange={() => setClientMode("direct")}
                />
                <span className="client-mode-copy">
                  <strong>客户端直执<span className="client-device-tag">默认推荐</span></strong>
                  <small>零镜像零同步，秒开使用，所有文件与命令均在本机直接执行。</small>
                </span>
              </label>
              <label className={`client-mode-option${clientMode === "mirrored" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="editClientMode"
                  value="mirrored"
                  checked={clientMode === "mirrored"}
                  disabled={saving || active || (!clientOnline && currentClientMode !== "mirrored")}
                  onChange={() => setClientMode("mirrored")}
                />
                <span className="client-mode-copy">
                  <strong>镜像同步</strong>
                  <small>双向同步至 Hub 镜像以使用 CLI 原生文件工具，仅命令回客户端执行。</small>
                </span>
              </label>
            </div>
            {clientMode !== currentClientMode && clientMode === "mirrored" && (
              <p className="form-hint">切换为「镜像同步」后将触发后台双向同步，完成前暂不可发送任务。</p>
            )}
            {clientMode !== currentClientMode && clientMode === "direct" && (
              <p className="form-hint">切换为「客户端直执」后将停止镜像同步，并清理 Hub 上的镜像文件及未同步的镜像修改，直接操作客户端本机目录。</p>
            )}
            {active && <p className="form-hint">请等待当前项目的任务结束后再切换运行模式。</p>}
            {!clientOnline && (
              <p className="form-hint">
                {currentClientMode === "mirrored"
                  ? "客户端当前离线，仍可切回「客户端直执」以清理 Hub 镜像；切回后需客户端重新连接方可继续使用。"
                  : "客户端离线，请在桌面客户端确认连接后再切换为「镜像同步」。"}
              </p>
            )}
          </>
        ) : (
          <>
            <label>{local ? "本机工作目录" : "统一工作目录"}<input value={project.local_path} readOnly /></label>
            {!local && <label>远端实际目录<input value={project.remote_path} readOnly /></label>}
            <p className="form-hint">当前执行方式：{executionLabel}</p>
            {local ? <p>CLI 与终端直接在此目录运行，文件修改立即生效。</p> : direct ? <p>两端使用相同的实际目录，无需挂载或软链接。</p> : <>
              <label>
                路径统一方式
                <select value={pathMode} onChange={(event) => setPathMode(event.target.value)} disabled={saving || active}>
                  <option value="auto">自动：优先 bwrap，缺少时使用软链接</option>
                  <option value="bwrap">bwrap 挂载（需远端支持）</option>
                  <option value="symlink">软链接</option>
                </select>
              </label>
              <p className="form-hint">推荐在开发机安装 bwrap。自动模式下安装后点击「立即同步」即可重新检测；软链接下 realpath 等仍可能显示实际目录。</p>
              {active && <p className="form-hint">请等待当前项目的任务结束后再修改路径方式。</p>}
            </>}
          </>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={saving} onClick={() => setOpen(false)}>
            {direct || local ? "关闭" : "取消"}
          </button>
          {(!direct && !local) && (
            <button
              className="button button-primary"
              disabled={saving || active || (isClient && (clientUnchanged || (requiresOnlineForSwitch && !clientOnline)))}
            >
              {saving && <LoaderCircle className="spin" size={15} />}
              {isClient
                ? saving ? "正在切换模式…" : clientMode === "mirrored" ? "保存并开始同步" : "保存模式"
                : saving ? "正在更新和同步…" : "保存并同步"}
            </button>
          )}
        </div>
      </form>
    </Modal>}
  </>;
}
