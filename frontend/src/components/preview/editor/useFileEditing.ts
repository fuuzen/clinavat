import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../../../api";
import { isPreconditionFailure, writeWorkspaceFile } from "../../workspace/transfers";
import type { FileMeta } from "../fileKinds";
import type { EditorHandle } from "./TextEditor";

interface Version {
  content: string;
  etag: string;
}

export type FileEditing = ReturnType<typeof useFileEditing>;

export function useFileEditing(projectId: string, path: string, meta: FileMeta | null, onMeta: (meta: FileMeta) => void) {
  // The version the editor started from or last saved; saving only succeeds while the file still has it.
  const [base, setBase] = useState<Version | null>(null);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const editor = useRef<EditorHandle>(null);

  const begin = useCallback((version: FileMeta) => {
    if (version.content === undefined) return;
    setBase({ content: version.content, etag: version.etag });
    setRevision((value) => value + 1);
    setDirty(false);
    setConflict(false);
    setError("");
  }, []);
  const stop = useCallback(() => {
    setBase(null);
    setDirty(false);
    setConflict(false);
    setError("");
  }, []);
  useEffect(stop, [projectId, path, stop]);

  const changedElsewhere = !!base && !!meta && meta.etag !== base.etag && !saving;
  // Without local changes there is nothing to lose, so a newer version on disk is simply taken over.
  useEffect(() => {
    if (!changedElsewhere || dirty || !meta) return;
    if (meta.content === undefined) stop();
    else begin(meta);
  }, [changedElsewhere, dirty, meta, begin, stop]);

  const save = useCallback(async (overwrite = false) => {
    const text = editor.current?.value();
    if (!base || text === undefined || saving) return;
    setSaving(true);
    setError("");
    try {
      const file = await writeWorkspaceFile(projectId, path, new Blob([text]), overwrite ? {} : { precondition: { etag: base.etag } });
      setBase({ content: text, etag: file.etag });
      setConflict(false);
      onMeta({ path, size: file.size, mtime: file.mtime, etag: file.etag, binary: false, content: text });
    } catch (cause) {
      if (isPreconditionFailure(cause)) setConflict(true);
      else setError(`保存失败：${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  }, [base, saving, projectId, path, onMeta]);

  const reload = useCallback(async () => {
    try {
      const latest = await api<FileMeta>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
      onMeta(latest);
      if (latest.content === undefined) stop();
      else begin(latest);
    } catch (cause) {
      setError(`无法载入最新版本：${errorText(cause)}`);
    }
  }, [projectId, path, onMeta, begin, stop]);

  return { editing: !!base, base, revision, editor, dirty, setDirty, saving, conflict, error, changedElsewhere, begin, stop, save, reload };
}
