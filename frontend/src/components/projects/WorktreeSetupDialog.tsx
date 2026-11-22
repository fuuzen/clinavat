import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { api, errorText } from "../../api";
import type { Project } from "../../types";
import { Modal } from "../Dialogs";

interface Props {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}

/** The command the Hub runs in each new Git worktree of a child agent; .worktreeinclude covers files to copy. */
export default function WorktreeSetupDialog({ project, onClose, onSaved }: Props) {
  const [command, setCommand] = useState(project.worktree_setup ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/projects/${project.id}/worktree-setup`, { method: "PUT", body: JSON.stringify({ command: command.trim() || null }) });
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  }

  return (
    <Modal title="子智能体 worktree" subtitle={project.name} wide onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form" onSubmit={save}>
        <label>
          初始化命令
          <textarea
            className="sync-rules-editor"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={saving}
            spellCheck={false}
            placeholder="pnpm install --offline"
          />
        </label>
        <p className="form-hint">
          可写子智能体默认在自己的 Git worktree 和分支中工作。创建 worktree 后，这条命令在其中执行一次（{project.execution_mode === "local" ? "在宿主机上" : "在开发机上"}，最长 10 分钟），用于安装依赖等准备工作。它由本系统直接执行，不经过审批；失败时只在派生结果中提示。
        </p>
        <p className="form-hint">
          需要带入 worktree 的未跟踪文件（例如 .env）写在仓库根目录的 .worktreeinclude 中，语法与 .gitignore 相同，创建时会从主目录复制。
        </p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={saving} onClick={onClose}>取消</button>
          <button className="button button-primary" disabled={saving || command.trim() === (project.worktree_setup ?? "")}>
            {saving && <LoaderCircle className="spin" size={15} />}
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
