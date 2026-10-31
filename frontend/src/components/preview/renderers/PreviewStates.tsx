import type { ReactNode } from "react";
import { Download, LoaderCircle, type LucideIcon } from "lucide-react";
import { formatBytes } from "../../../api";
import { fileName, iconFor, kindInfo, rawUrl, detectKind, type PreviewSource } from "../fileKinds";

export function PreviewLoading({ label = "正在加载预览" }: { label?: string }) {
  return (
    <div className="preview-state">
      <LoaderCircle size={20} className="spin" />
      <p>{label}</p>
    </div>
  );
}

export function DownloadButton({ source, primary = true }: { source: PreviewSource; primary?: boolean }) {
  return (
    <a
      className={primary ? "preview-primary-button" : "preview-secondary-button"}
      href={rawUrl(source.projectId, source.path, { download: true })}
      download={fileName(source.path)}
    >
      <Download size={14} />
      下载文件
    </a>
  );
}

export function PreviewMessage({
  source,
  icon,
  title,
  detail,
  actions,
}: {
  source: PreviewSource;
  icon?: LucideIcon;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  const Icon = icon ?? iconFor(source.path);
  return (
    <div className="preview-state preview-card">
      <span className={`preview-card-icon tone-${kindInfo[detectKind(source.path)].tone}`}>
        <Icon size={28} strokeWidth={1.6} />
      </span>
      <strong>{title}</strong>
      <p className="preview-card-name" title={source.path}>
        {fileName(source.path)} · {formatBytes(source.size)}
      </p>
      {detail && <p className="preview-card-detail">{detail}</p>}
      <div className="preview-card-actions">
        {actions}
        <DownloadButton source={source} primary={!actions} />
      </div>
    </div>
  );
}

export default function BinaryCard({ source }: { source: PreviewSource }) {
  const kind = detectKind(source.path);
  const detail = kind === "archive"
    ? "压缩包不在线解压，下载后在本地查看。"
    : kind === "code" || kind === "markdown" || kind === "csv" || kind === "notebook"
      ? "文本文件超过 1 MiB，为保持流畅不在线渲染。"
      : "这种文件类型暂不支持在线预览。";
  return <PreviewMessage source={source} title="下载后查看" detail={detail} />;
}
