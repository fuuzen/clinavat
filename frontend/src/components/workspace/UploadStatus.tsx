import { useEffect } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { formatBytes } from "../../api";
import type { UploadProgress } from "./useUploads";

interface Props {
  progress: UploadProgress;
  onCancel: () => void;
  onDismiss: () => void;
}

function summary(progress: UploadProgress, percent: number): string {
  if (progress.running) return `正在上传 ${progress.uploaded}/${progress.total} · ${percent}%`;
  if (progress.cancelled) return `已取消，${progress.uploaded} 个文件已上传`;
  if (progress.failures.length) return `${progress.uploaded} 个已上传，${progress.failures.length} 个失败`;
  return progress.uploaded ? `已上传 ${progress.uploaded} 个文件` : "没有上传新文件";
}

export default function UploadStatus({ progress, onCancel, onDismiss }: Props) {
  const notes = [
    progress.kept > 0 && `保留了 ${progress.kept} 个同名文件`,
    progress.skipped > 0 && `跳过了 ${progress.skipped} 项 .git / .bin 内容`,
  ].filter(Boolean).join("，");
  const clean = !progress.running && !progress.cancelled && !progress.failures.length && !notes;
  useEffect(() => {
    if (!clean) return;
    const timer = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(timer);
  }, [clean, onDismiss]);
  const percent = progress.totalBytes ? Math.min(100, Math.floor((progress.sentBytes / progress.totalBytes) * 100)) : progress.running ? 0 : 100;
  const failed = progress.failures.length > 0 || progress.cancelled;
  return (
    <section className={`upload-status${failed ? " has-failures" : ""}`} aria-live="polite">
      <div className="upload-status-summary">
        {progress.running ? <LoaderCircle size={13} className="spin" /> : failed ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
        <span>{summary(progress, percent)}</span>
        <button
          className="icon-button"
          onClick={progress.running ? onCancel : onDismiss}
          aria-label={progress.running ? "取消上传" : "关闭上传结果"}
          title={progress.running ? "取消上传" : "关闭"}
        >
          <X size={13} />
        </button>
      </div>
      {progress.running && (
        <>
          <div className="upload-status-bar"><span style={{ width: `${percent}%` }} /></div>
          <small title={progress.current}>
            {formatBytes(progress.sentBytes)} / {formatBytes(progress.totalBytes)}
            {progress.current && <> · {progress.current}</>}
          </small>
        </>
      )}
      {notes && <small>{notes}</small>}
      {progress.failures.length > 0 && (
        <ul>
          {progress.failures.slice(0, 5).map((failure) => (
            <li key={failure.path}>
              <strong title={failure.path}>{failure.path}</strong>
              <span>{failure.error}</span>
            </li>
          ))}
          {progress.failures.length > 5 && <li>另有 {progress.failures.length - 5} 个文件失败</li>}
        </ul>
      )}
    </section>
  );
}
