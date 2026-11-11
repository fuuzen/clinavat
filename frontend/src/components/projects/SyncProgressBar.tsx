import { formatBytes } from "../../api";
import type { SyncProgress } from "../../types";

function progressDetail(progress: SyncProgress) {
  const parts = [];
  if (progress.expectedFiles) parts.push(`${progress.receivedFiles ?? 0} / ${progress.expectedFiles} 个文件`);
  if (progress.receivedBytes !== undefined && progress.totalBytes)
    parts.push(`${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`);
  else if (progress.totalBytes) parts.push(`共 ${formatBytes(progress.totalBytes)}`);
  if (progress.ratio !== null) parts.push(`${Math.floor(progress.ratio * 100)}%`);
  return parts.join(" · ");
}

export default function SyncProgressBar({ progress, compact = false }: { progress?: SyncProgress; compact?: boolean }) {
  const ratio = progress?.ratio ?? null;
  const description = progress?.description || "正在准备首次同步";
  const detail = progress ? progressDetail(progress) : "";
  return (
    <div
      className={`sync-progress${compact ? " sync-progress-compact" : ""}`}
      role="progressbar"
      aria-label={`首次同步：${description}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={ratio === null ? undefined : Math.floor(ratio * 100)}
      title={compact ? [description, detail].filter(Boolean).join(" · ") : undefined}
    >
      <div className="sync-progress-track">
        <span className={ratio === null ? "sync-progress-indeterminate" : undefined} style={ratio === null ? undefined : { width: `${ratio * 100}%` }} />
      </div>
      {!compact && (
        <div className="sync-progress-text">
          <span>{description}</span>
          {detail && <span>{detail}</span>}
        </div>
      )}
    </div>
  );
}
