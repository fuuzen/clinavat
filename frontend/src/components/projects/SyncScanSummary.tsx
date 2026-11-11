import { File, Folder } from "lucide-react";
import { formatBytes } from "../../api";
import type { SyncScan } from "../../types";

export default function SyncScanSummary({
  scan,
  excluded,
  disabled,
  onToggle,
}: {
  scan: SyncScan;
  excluded: Set<string>;
  disabled: boolean;
  onToggle: (path: string) => void;
}) {
  const excludedBytes = scan.entries
    .filter((entry) => excluded.has(entry.path))
    .reduce((sum, entry) => sum + entry.bytes, 0);
  return (
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
                disabled={disabled}
                onChange={() => onToggle(entry.path)}
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
  );
}
