import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileWarning, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { RendererProps } from "../fileKinds";
import { PageIndicator, ViewerControls } from "../PreviewToolbar";
import { useRawBuffer } from "../useRawBuffer";
import { PreviewLoading, PreviewMessage } from "./PreviewStates";

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = `${import.meta.env.BASE_URL}pdfjs/`;

function openDocument(buffer: ArrayBuffer) {
  return getDocument({
    data: buffer,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  }).promise;
}

interface PageProps {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  aspect: number;
  root: HTMLElement | null;
  textLayer?: boolean;
  onAspect?: (number: number, aspect: number) => void;
}

const PdfPage = memo(function PdfPage({ doc, number, width, aspect, root, textLayer, onAspect }: PageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || !root) return;
    // Only pages around the viewport keep a canvas; distant ones are released to bound memory on long documents.
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: "900px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near || width <= 0) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onAspect?.(number, base.height / base.width);
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await task.promise;
      if (cancelled) return;
      setRendered(true);
      const container = textRef.current;
      if (textLayer && container) {
        container.replaceChildren();
        container.style.setProperty("--total-scale-factor", String(scale));
        await new TextLayer({ textContentSource: page.streamTextContent(), container, viewport }).render();
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      setRendered(false);
      const canvas = canvasRef.current;
      if (canvas) canvas.width = canvas.height = 0;
      textRef.current?.replaceChildren();
    };
  }, [doc, number, width, near, textLayer, onAspect]);

  return (
    <div ref={wrapperRef} className={`pdf-page${rendered ? " rendered" : ""}`} data-page={number} style={{ width, height: width * aspect }}>
      <canvas ref={canvasRef} style={{ width, height: width * aspect }} />
      {textLayer && <div ref={textRef} className="textLayer" />}
    </div>
  );
});

function PdfDocument({ doc, expanded }: { doc: PDFDocumentProxy; expanded: boolean }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const defaultAspect = aspects[1] ?? 1.414;
  const total = doc.numPages;
  const padding = expanded ? 64 : 28;
  // Fit-width is capped in the large viewer so text lines stay readable on wide screens.
  const fitWidth = Math.max(120, Math.min(available - padding, expanded ? 980 : Infinity));
  const width = Math.round(fitWidth * zoom);

  const recordAspect = useCallback((number: number, aspect: number) => {
    setAspects((current) => (Math.abs((current[number] ?? 0) - aspect) < 0.001 ? current : { ...current, [number]: aspect }));
  }, []);
  useEffect(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => {
      const middle = scroller.scrollTop + scroller.clientHeight / 3;
      const pages = scroller.querySelectorAll<HTMLElement>(".pdf-page");
      let current = 1;
      for (const element of pages) {
        if (element.offsetTop <= middle) current = Number(element.dataset.page);
        else break;
      }
      setPage(current);
    };
    // Ctrl/⌘ + wheel zooms the document instead of the browser page.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((value) => Math.min(4, Math.max(0.4, value * Math.exp(-event.deltaY * 0.002))));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
    };
  }, [scroller]);

  const goTo = useCallback(
    (target: number) => {
      const clamped = Math.min(total, Math.max(1, target));
      scroller?.querySelector(`.pdf-page[data-page="${clamped}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      setPage(clamped);
    },
    [scroller, total],
  );
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") goTo(page + 1);
      else if (event.key === "ArrowLeft" || event.key === "PageUp") goTo(page - 1);
      else if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(4, value * 1.15));
      else if (event.key === "-") setZoom((value) => Math.max(0.4, value / 1.15));
      else if (event.key === "0") setZoom(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, goTo, page]);
  useEffect(() => {
    rail?.querySelector(`[data-thumb="${page}"]`)?.scrollIntoView({ block: "nearest" });
  }, [rail, page]);

  const numbers = Array.from({ length: total }, (_, index) => index + 1);
  return (
    <div className="pdf-viewer">
      {expanded && total > 1 && (
        <div className="pdf-rail" ref={setRail}>
          {numbers.map((number) => (
            <button key={number} data-thumb={number} className={number === page ? "active" : ""} onClick={() => goTo(number)}>
              <PdfPage doc={doc} number={number} width={112} aspect={aspects[number] ?? defaultAspect} root={rail} />
              <span>{number}</span>
            </button>
          ))}
        </div>
      )}
      <div className="pdf-scroll" ref={setScroller}>
        <div className="pdf-pages" style={{ padding: `${padding / 2}px` }}>
          {available > 0 &&
            numbers.map((number) => (
              <PdfPage
                key={number}
                doc={doc}
                number={number}
                width={width}
                aspect={aspects[number] ?? defaultAspect}
                root={scroller}
                textLayer
                onAspect={recordAspect}
              />
            ))}
        </div>
      </div>
      <ViewerControls>
        <button onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label="上一页" title="上一页">
          <ChevronLeft size={15} />
        </button>
        <PageIndicator page={page} total={total} onChange={goTo} />
        <button onClick={() => goTo(page + 1)} disabled={page >= total} aria-label="下一页" title="下一页">
          <ChevronRight size={15} />
        </button>
        <i />
        <button onClick={() => setZoom((value) => Math.max(0.4, value / 1.2))} aria-label="缩小" title="缩小">
          <ZoomOut size={14} />
        </button>
        <span className="viewer-zoom-label">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((value) => Math.min(4, value * 1.2))} aria-label="放大" title="放大">
          <ZoomIn size={14} />
        </button>
        <button onClick={() => setZoom(1)} className={zoom === 1 ? "active" : ""} aria-label="适应宽度" title="适应宽度">
          <MoveHorizontal size={14} />
        </button>
      </ViewerControls>
    </div>
  );
}

export default function PdfView({ source, expanded }: RendererProps) {
  const state = useRawBuffer(source.url, openDocument);
  useEffect(() => {
    if (state.status !== "ready") return;
    return () => void state.value.loadingTask.destroy();
  }, [state]);
  if (state.status === "loading") return <PreviewLoading label="正在打开 PDF" />;
  if (state.status === "error") {
    return <PreviewMessage source={source} icon={FileWarning} title="PDF 无法打开" detail={state.error.includes("password") ? "文档受密码保护。" : state.error} />;
  }
  return <PdfDocument doc={state.value} expanded={expanded} />;
}
