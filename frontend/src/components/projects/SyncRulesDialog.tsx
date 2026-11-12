import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { api, errorText } from "../../api";
import type { Project, SyncRules } from "../../types";
import { Modal } from "../Dialogs";
import { literalIgnore } from "./linkGroups";

interface Props {
  project: Project;
  /** Project paths to add as rules, such as symbolic links the sync skips. */
  append?: string[];
  onClose: () => void;
  onSaved: () => void;
}

function withAppended(rules: string, paths: string[]): string {
  const existing = new Set(rules.split(/\r?\n/).map((line) => line.trim()));
  const additions = paths.map(literalIgnore).filter((rule) => !existing.has(rule));
  if (!additions.length) return rules;
  const base = rules.trimEnd();
  return `${base}${base ? "\n" : ""}# 无法同步的软链接\n${additions.join("\n")}\n`;
}

export default function SyncRulesDialog({ project, append, onClose, onSaved }: Props) {
  const [loaded, setLoaded] = useState<SyncRules | null>(null);
  const [rules, setRules] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<SyncRules>(`/projects/${project.id}/sync-rules`).then((result) => {
      if (cancelled) return;
      setLoaded(result);
      setRules(withAppended(result.rules, append ?? []));
    }, (cause) => {
      if (!cancelled) setError(errorText(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/projects/${project.id}/sync-rules`, { method: "PUT", body: JSON.stringify({ rules }) });
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  }

  return (
    <Modal title="同步排除规则" subtitle={project.name} wide onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form" onSubmit={save}>
        <label>
          本项目的排除规则
          <textarea
            className="sync-rules-editor"
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            disabled={!loaded || saving}
            spellCheck={false}
            placeholder={"/runs\n/third_party/bin"}
          />
        </label>
        <p className="form-hint">
          每行一条 Mutagen 忽略规则：# 开头为注释，! 表示重新包含，以 / 开头只匹配项目根目录下的路径。规则由 Clinavat 保存，不会在开发机上写文件；Git 忽略的未跟踪文件会自动排除。
        </p>
        <p className="form-hint">
          只有同步已完成、项目中没有运行的对话时才能保存。保存后按新规则在后台重新同步：新排除的路径从镜像中移除（开发机上的文件保留），不再排除的路径从开发机拉取。
        </p>
        {loaded && (
          <details className="sync-rules-defaults">
            <summary>内置规则（始终生效）</summary>
            <code>{loaded.defaults.join("  ")}</code>
          </details>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" disabled={saving} onClick={onClose}>取消</button>
          <button className="button button-primary" disabled={!loaded || saving || rules === loaded.rules}>
            {saving && <LoaderCircle className="spin" size={15} />}
            {saving ? "正在检查同步状态…" : "保存并重新同步"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
