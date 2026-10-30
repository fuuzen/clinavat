import { useEffect, useState, type FormEvent } from "react";
import { CircleHelp, Container, FolderCheck, Laptop, Link2, LoaderCircle } from "lucide-react";
import { api, errorText } from "../../api";
import type { Project } from "../../types";
import { Modal } from "../Dialogs";

interface Props {
  project: Project;
  active: boolean;
  onRefresh: () => Promise<void>;
}

const executionLabels = {
  local: "本机目录",
  direct: "同路径",
  bwrap: "bwrap 挂载",
  symlink: "软链接",
};

export default function ProjectPathSettings({ project, active, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [pathMode, setPathMode] = useState("auto");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const direct = project.path_mode === "direct";
  const local = project.execution_mode === "local";
  const executionLabel = project.execution_mode ? executionLabels[project.execution_mode] : "路径未就绪";
  const PathIcon = local ? Laptop : project.execution_mode === "direct" ? FolderCheck
    : project.execution_mode === "bwrap" ? Container
    : project.execution_mode === "symlink" ? Link2 : CircleHelp;

  useEffect(() => { setOpen(false); }, [project.id]);

  function showSettings() {
    setPathMode(direct ? "auto" : project.path_mode || "auto");
    setError("");
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pathMode }),
      });
      setOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await onRefresh().catch(() => undefined);
      setSaving(false);
    }
  }

  return <>
    <button
      className={`path-mode-button path-mode-${project.execution_mode || "pending"}`}
      onClick={showSettings}
      title={local ? `本机工作目录：${project.local_path}` : `路径统一方式：${executionLabel}，点击查看设置`}
      aria-label={`项目路径设置：${executionLabel}`}
    >
      <PathIcon size={14} aria-hidden="true" />
      <span className="path-mode-label">{executionLabel}</span>
    </button>
    {open && <Modal title="项目路径" subtitle={project.name} onClose={() => { if (!saving) setOpen(false); }}>
      <form className="modal-form" onSubmit={save}>
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
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={saving} onClick={() => setOpen(false)}>{direct || local ? "关闭" : "取消"}</button>
          {!direct && !local && <button className="button button-primary" disabled={saving || active}>
            {saving && <LoaderCircle className="spin" size={15} />}
            {saving ? "正在更新和同步…" : "保存并同步"}
          </button>}
        </div>
      </form>
    </Modal>}
  </>;
}
