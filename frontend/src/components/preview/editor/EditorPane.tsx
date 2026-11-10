import { AlertCircle, TriangleAlert } from "lucide-react";
import TextEditor from "./TextEditor";
import type { FileEditing } from "./useFileEditing";

export default function EditorPane({ editing, path, wrap }: { editing: FileEditing; path: string; wrap: boolean }) {
  if (!editing.base) return null;
  const outdated = editing.conflict || (editing.changedElsewhere && editing.dirty);
  return (
    <div className="editor-pane">
      {outdated ? (
        <div className="editor-notice warning" role="alert">
          <TriangleAlert size={14} />
          <span>文件已在其他地方被修改，保存会覆盖那些修改。</span>
          <button onClick={() => void editing.save(true)} disabled={editing.saving}>覆盖保存</button>
          <button onClick={() => window.confirm("放弃你的修改并载入最新版本？") && void editing.reload()}>载入最新版本</button>
        </div>
      ) : editing.error ? (
        <div className="editor-notice danger" role="alert">
          <AlertCircle size={14} />
          <span>{editing.error}</span>
        </div>
      ) : null}
      <TextEditor
        key={editing.revision}
        ref={editing.editor}
        initial={editing.base.content}
        baseline={editing.base.content}
        path={path}
        wrap={wrap}
        onDirtyChange={editing.setDirty}
        onSave={() => void editing.save()}
      />
    </div>
  );
}
