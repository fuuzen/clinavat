import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ImageOff, Scan, ZoomIn, ZoomOut } from "lucide-react";
import type { RendererProps } from "../fileKinds";
import { ViewerControls } from "../PreviewToolbar";
import { CodeBlock } from "./CodeView";
import { PreviewLoading, PreviewMessage } from "./PreviewStates";

const minScale = 0.05;
const maxScale = 16;
const clamp = (value: number) => Math.min(maxScale, Math.max(minScale, value));

export default function ImageView({ source, showSource, wrap }: RendererProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => undefined);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setStage({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [showSource]);
  useEffect(() => {
    setNatural(null);
    setZoom(null);
    setOffset({ x: 0, y: 0 });
    setFailed(false);
  }, [source.url]);
  // React registers wheel listeners as passive, which would let the page scroll instead of zooming.
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheelHandler.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [showSource, failed]);

  if (showSource) {
    return (
      <div className="preview-scroll">
        <CodeBlock code={source.content ?? ""} language="xml" numbered wrap={wrap} />
      </div>
    );
  }
  if (failed) return <PreviewMessage source={source} icon={ImageOff} title="图片无法显示" detail="浏览器不支持这种图片格式，或文件已损坏。" />;

  const padding = 48;
  // Tiny assets such as icons are enlarged up to 4x so they stay legible when fitted.
  const fitScale = natural && stage.width
    ? Math.min((stage.width - padding) / natural.width, (stage.height - padding) / natural.height, natural.width < 64 ? 4 : 1)
    : 1;
  const scale = zoom ?? fitScale;

  function zoomAt(next: number, point = { x: 0, y: 0 }) {
    const target = clamp(next);
    setOffset((current) => ({
      x: point.x - (point.x - current.x) * (target / scale),
      y: point.y - (point.y - current.y) * (target / scale),
    }));
    setZoom(target);
  }
  function fit() {
    setZoom(null);
    setOffset({ x: 0, y: 0 });
  }
  function pointerOffset(event: { clientX: number; clientY: number }) {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  }
  wheelHandler.current = (event) => {
    event.preventDefault();
    zoomAt(scale * Math.exp(-event.deltaY * 0.0015), pointerOffset(event));
  };
  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y };
    setDragging(true);
  }
  function endDrag() {
    drag.current = null;
    setDragging(false);
  }
  function onPointerMove(event: PointerEvent) {
    if (!drag.current) return;
    setOffset({ x: drag.current.originX + event.clientX - drag.current.x, y: drag.current.originY + event.clientY - drag.current.y });
  }

  return (
    <div className="image-viewer">
      <div
        ref={stageRef}
        className={`image-stage${dragging ? " dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => (zoom === null || Math.abs(scale - fitScale) < 0.01 ? zoomAt(Math.max(1, fitScale * 2), pointerOffset(event)) : fit())}
      >
        {!natural && <PreviewLoading />}
        <img
          src={source.url}
          alt={source.path}
          draggable={false}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth || 512, height: event.currentTarget.naturalHeight || 512 })}
          onError={() => setFailed(true)}
          style={{
            opacity: natural ? 1 : 0,
            width: natural?.width,
            height: natural?.height,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            imageRendering: scale > 2 ? "pixelated" : undefined,
          }}
        />
      </div>
      {natural && (
        <ViewerControls>
          <button onClick={() => zoomAt(scale / 1.25)} aria-label="缩小" title="缩小">
            <ZoomOut size={14} />
          </button>
          <button className="viewer-zoom-label" onClick={fit} title="适应窗口">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomAt(scale * 1.25)} aria-label="放大" title="放大">
            <ZoomIn size={14} />
          </button>
          <i />
          <button onClick={fit} className={zoom === null ? "active" : ""} aria-label="适应窗口" title="适应窗口">
            <Scan size={14} />
          </button>
          <button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} className={zoom === 1 ? "active" : ""} title="原始尺寸">
            1:1
          </button>
          <i />
          <span className="viewer-meta">
            {natural.width} × {natural.height}
          </span>
        </ViewerControls>
      )}
    </div>
  );
}
