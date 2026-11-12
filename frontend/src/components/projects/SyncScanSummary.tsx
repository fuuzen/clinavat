import { File, Folder, Link2 } from "lucide-react";
import { formatBytes } from "../../api";
import type { SyncScan, SyncScanLink } from "../../types";
import { groupByDirectory } from "./linkGroups";

const linkKinds: Record<SyncScanLink["kind"], { tag: string; hint: string }> = {
  project: {
    tag: "指向项目内",
    hint: "目标是项目内的绝对路径：建议在开发机上改为相对路径软链接（ln -sfr 目标 链接名），也可以排除。",
  },
  workspace: {
    tag: "旧工作区路径",
    hint: "目标在 Clinavat 工作区路径下，多为在之前的项目中编译生成，重新创建项目后已失效：建议重新编译，或排除所在的编译目录。",
  },
  outside: { tag: "指向项目外", hint: "目标在项目外：建议排除，需要时在开发机上直接使用。" },
  invalid: { tag: "目标无效", hint: "目标为空或含有冒号、反斜杠：建议排除。" },
};

/** A directory holding several links is offered as a whole, other links one by one. */
function linkCandidates(links: SyncScanLink[]) {
  return groupByDirectory(links).flatMap(({ directory, items }) =>
    directory && items.length > 1
      ? [{ path: directory, directory: true, links: items }]
      : items.map((link) => ({ path: link.path, directory: false, links: [link] })));
}

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
      {scan.linkCount > 0 && <ScanLinks scan={scan} excluded={excluded} disabled={disabled} onToggle={onToggle} />}
      <p className="form-hint">
        勾选的路径会加入本项目的同步排除规则，不再同步到号池机；之后可在工作区底部的「排除规则」中修改。
        {scan.truncated && "文件过多，统计只覆盖了部分文件。"}
      </p>
    </div>
  );
}

function ScanLinks({ scan, excluded, disabled, onToggle }: {
  scan: SyncScan;
  excluded: Set<string>;
  disabled: boolean;
  onToggle: (path: string) => void;
}) {
  const kinds = [...new Set(scan.links.map((link) => link.kind))];
  return (
    <>
      <div className="sync-scan-heading">
        <span>无法同步的软链接</span>
        <span>{scan.linkCount} 个，同步时跳过</span>
      </div>
      <div className="sync-scan-list">
        {linkCandidates(scan.links).map((candidate) => (
          <label key={candidate.path} title={candidate.links.map((link) => `${link.path} → ${link.target}`).join("\n")}>
            <input
              type="checkbox"
              checked={excluded.has(candidate.path)}
              disabled={disabled}
              onChange={() => onToggle(candidate.path)}
            />
            {candidate.directory ? <Folder size={14} /> : <Link2 size={14} />}
            <span className="sync-scan-path">
              {candidate.path}
              {candidate.directory ? "/" : ""}
            </span>
            {[...new Set(candidate.links.map((link) => link.kind))].map((kind) => (
              <span key={kind} className="sync-scan-tag">{linkKinds[kind].tag}</span>
            ))}
            {candidate.directory && <span className="sync-scan-size">{candidate.links.length} 个</span>}
          </label>
        ))}
      </div>
      <p className="form-hint">
        只有指向项目内的相对路径软链接能够同步，下列软链接会被跳过，只存在于开发机。
        {kinds.map((kind) => linkKinds[kind].hint).join("")}
        {scan.linkCount > scan.links.length && `另有 ${scan.linkCount - scan.links.length} 个未列出。`}
      </p>
    </>
  );
}
