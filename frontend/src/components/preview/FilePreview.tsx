import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Download, Maximize2 } from "lucide-react";
import { api, errorText } from "../../api";
import { detectKind, fileName, kindInfo, rawUrl, type FileKind, type FileMeta, type PreviewSource, type RendererProps } from "./fileKinds";
import PreviewToolbar from "./PreviewToolbar";
import BinaryCard, { PreviewLoading, PreviewMessage } from "./renderers/PreviewStates";
import { useFileEditing } from "./editor/useFileEditing";

const EditorPane = lazy(() => import("./editor/EditorPane"));
const CodeView = lazy(() => import("./renderers/CodeView"));
const MediaView = lazy(() => import("./renderers/MediaView"));
const SheetView = lazy(() => import("./renderers/SheetView"));
const renderers: Partial<Record<FileKind, ComponentType<RendererProps>>> = {
  code: CodeView,
  markdown: lazy(() => import("./renderers/MarkdownView")),
  image: lazy(() => import("./renderers/ImageView")),
  pdf: lazy(() => import("./renderers/PdfView")),
  slides: lazy(() => import("./renderers/SlidesView")),
  document: lazy(() => import("./renderers/DocxView")),
  sheet: SheetView,
  csv: SheetView,
  audio: MediaView,
  video: MediaView,
  notebook: lazy(() => import("./renderers/NotebookView")),
};
renderers.svg = renderers.image;

// Parsing very large office files or PDFs in the browser can stall the tab, so it is opt-in past this size.
const heavyPreviewBytes = 40 * 1024 * 1024;
const wrapPreference = "clinavat.preview.wrap";

interface Props {
  projectId: string;
  path: string;
  refresh: number;
  onBack: () => void;
  onOpen: (path: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

class RendererBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function FilePreview({ projectId, path, refresh, onBack, onOpen, onDirtyChange }: Props) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  // A metadata request still in flight when a save lands would otherwise bring back the version before it.
  const localWrites = useRef(0);
  const adoptSaved = useCallback((saved: FileMeta) => {
    localWrites.current++;
    setMeta(saved);
  }, []);
  const editing = useFileEditing(projectId, path, meta, adoptSaved);
  const unsaved = editing.editing && editing.dirty;
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem(wrapPreference) === "1");
  const [heavyConfirmed, setHeavyConfirmed] = useState(false);
  // The viewer lives in a detached node that is moved between the sidebar and the modal, so expanding never remounts it.
  const [host] = useState(() => Object.assign(document.createElement("div"), { className: "preview-host" }));
  const dockRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMeta(null);
    setShowSource(false);
    setHeavyConfirmed(false);
  }, [projectId, path]);
  useEffect(() => {
    let cancelled = false;
    const writes = localWrites.current;
    setError("");
    api<FileMeta>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`)
      .then((result) => {
        if (cancelled || writes !== localWrites.current) return;
        // Keep the current object when nothing changed so refreshes do not re-render heavy viewers.
        setMeta((current) => (current?.path === result.path && current.etag === result.etag ? current : result));
      })
      .catch((cause) => !cancelled && setError(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [projectId, path, refresh]);
  useEffect(() => {
    onDirtyChange?.(unsaved);
  }, [unsaved, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useLayoutEffect(() => {
    (expanded ? modalRef.current : dockRef.current)?.appendChild(host);
  }, [expanded, host]);
  useEffect(() => () => host.remove(), [host]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      // The editor consumes Escape itself, for example to close its search panel.
      if (event.key === "Escape" && !document.fullscreenElement && !event.defaultPrevented) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("preview-modal-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("preview-modal-open");
    };
  }, [expanded]);

  let kind = detectKind(path);
  // Text renderers need the inline payload; binary or oversized text falls back to the download card.
  if (meta && !kindInfo[kind].raw && meta.binary) kind = "binary";
  const canToggleSource = !!kindInfo[kind].hasSource && meta?.content !== undefined && !editing.editing;
  const textContent = kindInfo[kind].editable ? meta?.content : undefined;
  // Bytes that are not UTF-8 arrive as U+FFFD, so saving the text back would corrupt the file.
  const editBlocked = textContent?.includes("\uFFFD") ? "文件含有无法识别的字符（可能不是 UTF-8 编码），不支持在线编辑" : undefined;
  const leave = () => {
    if (!unsaved || window.confirm("文件有未保存的修改，确定放弃吗？")) onBack();
  };
  const stopEditing = () => {
    if (!editing.dirty || window.confirm("放弃未保存的修改？")) editing.stop();
  };
  const sourceVisible = canToggleSource && showSource;
  const downloadUrl = rawUrl(projectId, path, { download: true });
  const source: PreviewSource | undefined = meta
    ? { projectId, path, size: meta.size, mtime: meta.mtime, url: rawUrl(projectId, path, { version: meta.mtime }), content: meta.content }
    : undefined;
  const Renderer = renderers[kind];
  const heavy = !!source && !!kindInfo[kind].raw && ["pdf", "slides", "document", "sheet"].includes(kind) && source.size > heavyPreviewBytes;

  let body: ReactNode;
  if (editing.editing && source) {
    body = (
      <RendererBoundary key={`edit:${path}`} fallback={<PreviewMessage source={source} title="编辑器出现问题" detail="请刷新页面后重试，未保存的修改可能已经丢失。" />}>
        <Suspense fallback={<PreviewLoading label="正在加载编辑器" />}>
          <EditorPane editing={editing} path={path} wrap={wrap} />
        </Suspense>
      </RendererBoundary>
    );
  } else if (error) {
    body = (
      <div className="preview-state preview-card">
        <span className="preview-card-icon tone-danger">
          <AlertCircle size={26} strokeWidth={1.6} />
        </span>
        <strong>无法打开文件</strong>
        <p className="preview-card-detail">{error}</p>
        <div className="preview-card-actions">
          <a className="preview-secondary-button" href={downloadUrl} download={fileName(path)}>
            <Download size={14} />
            下载文件
          </a>
        </div>
      </div>
    );
  } else if (!source) body = <PreviewLoading />;
  else if (!Renderer) body = <BinaryCard source={source} />;
  else if (heavy && !heavyConfirmed) {
    body = (
      <PreviewMessage
        source={source}
        title="文件较大"
        detail="在浏览器中解析可能需要一些时间并占用较多内存。"
        actions={
          <button className="preview-primary-button" onClick={() => setHeavyConfirmed(true)}>
            仍然预览
          </button>
        }
      />
    );
  } else {
    body = (
      <RendererBoundary key={`${path}:${source.mtime}`} fallback={<PreviewMessage source={source} title="预览出现问题" detail="渲染这个文件时发生错误，可以下载后查看。" />}>
        <Suspense fallback={<PreviewLoading />}>
          <Renderer source={source} expanded={expanded} showSource={sourceVisible} wrap={wrap} onOpen={onOpen} />
        </Suspense>
      </RendererBoundary>
    );
  }

  const viewer = (
    <div className={`preview-viewer${expanded ? " expanded" : ""}`}>
      <PreviewToolbar
        path={path}
        kind={kind}
        size={meta?.size}
        downloadUrl={downloadUrl}
        expanded={expanded}
        showSource={sourceVisible}
        wrap={wrap}
        canToggleSource={canToggleSource}
        canWrap={kind === "code" || sourceVisible || kind === "notebook" || editing.editing}
        edit={{
          available: textContent !== undefined,
          blocked: editBlocked,
          active: editing.editing,
          dirty: editing.dirty,
          saving: editing.saving,
          onStart: () => meta && editing.begin(meta),
          onSave: () => void editing.save(),
          onStop: stopEditing,
        }}
        onBack={leave}
        onToggleExpanded={() => setExpanded((value) => !value)}
        onToggleSource={setShowSource}
        onToggleWrap={() =>
          setWrap((value) => {
            localStorage.setItem(wrapPreference, value ? "0" : "1");
            return !value;
          })
        }
      />
      <div className="preview-body">{body}</div>
    </div>
  );

  return (
    <>
      <div className="preview-dock" ref={dockRef}>
        {expanded && (
          <div className="preview-state preview-docked">
            <Maximize2 size={20} />
            <p>正在大窗口中查看</p>
            <button className="preview-secondary-button" onClick={() => setExpanded(false)}>
              收回侧栏
            </button>
          </div>
        )}
      </div>
      {expanded &&
        createPortal(
          <div className="preview-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setExpanded(false)}>
            <div className="preview-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={fileName(path)} />
          </div>,
          document.body,
        )}
      {createPortal(viewer, host)}
    </>
  );
}
