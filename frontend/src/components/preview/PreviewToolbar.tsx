import { useState, type ReactNode } from "react";
import { ArrowLeft, Check, Code2, Copy, Download, Eye, Maximize2, Minimize2, WrapText, X } from "lucide-react";
import { formatBytes } from "../../api";
import { fileName, iconFor, kindInfo, type FileKind } from "./fileKinds";

interface Props {
  path: string;
  kind: FileKind;
  size?: number;
  downloadUrl: string;
  expanded: boolean;
  showSource: boolean;
  wrap: boolean;
  canToggleSource: boolean;
  canWrap: boolean;
  onBack: () => void;
  onToggleExpanded: () => void;
  onToggleSource: (value: boolean) => void;
  onToggleWrap: () => void;
}

export default function PreviewToolbar(props: Props) {
  const { path, kind, size, expanded, showSource, wrap } = props;
  const [copied, setCopied] = useState(false);
  const Icon = iconFor(path);
  const directory = path.split("/").slice(0, -1).join("/");
  async function copyPath() {
    await navigator.clipboard.writeText(path).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <header className="preview-toolbar">
      <button
        className="icon-button"
        onClick={expanded ? props.onToggleExpanded : props.onBack}
        aria-label={expanded ? "收起大窗口" : "返回文件列表"}
        title={expanded ? "收起" : "返回"}
      >
        {expanded ? <X size={16} /> : <ArrowLeft size={15} />}
      </button>
      <span className={`preview-file-icon tone-${kindInfo[kind].tone}`}>
        <Icon size={15} />
      </span>
      <div className="preview-title" title={path}>
        <strong>{fileName(path)}</strong>
        <small>
          {kindInfo[kind].label}
          {size !== undefined && <> · {formatBytes(size)}</>}
          {expanded && directory && <> · {directory}</>}
        </small>
      </div>
      <div className="preview-actions">
        {props.canToggleSource && (
          <div className="preview-segment" role="group" aria-label="显示方式">
            <button className={!showSource ? "active" : ""} onClick={() => props.onToggleSource(false)} title="渲染预览">
              <Eye size={13} />
            </button>
            <button className={showSource ? "active" : ""} onClick={() => props.onToggleSource(true)} title="查看源码">
              <Code2 size={13} />
            </button>
          </div>
        )}
        {props.canWrap && (
          <button
            className={`icon-button ${wrap ? "is-active" : ""}`}
            onClick={props.onToggleWrap}
            aria-label="自动换行"
            title={wrap ? "关闭自动换行" : "自动换行"}
          >
            <WrapText size={14} />
          </button>
        )}
        <button className="icon-button" onClick={() => void copyPath()} aria-label="复制路径" title="复制路径">
          {copied ? <Check size={14} className="preview-copied" /> : <Copy size={14} />}
        </button>
        <a className="icon-button" href={props.downloadUrl} download={fileName(path)} aria-label="下载文件" title="下载">
          <Download size={14} />
        </a>
        <button
          className="icon-button"
          onClick={props.onToggleExpanded}
          aria-label={expanded ? "收起大窗口" : "在大窗口中查看"}
          title={expanded ? "收起 (Esc)" : "展开"}
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
    </header>
  );
}

// Floating glass pill that hosts renderer-specific controls (zoom, paging) over the viewport.
export function ViewerControls({ children }: { children: ReactNode }) {
  return <div className="viewer-controls">{children}</div>;
}

export function PageIndicator({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1 && value <= total) onChange(value);
    setDraft(null);
  }
  return (
    <span className="viewer-page">
      <input
        aria-label="页码"
        value={draft ?? String(page)}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
        style={{ width: `${Math.max(2, String(total).length) + 0.6}ch` }}
      />
      <span>/ {total}</span>
    </span>
  );
}
