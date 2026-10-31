import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { FileWarning } from "lucide-react";
import { errorText } from "../../../api";
import type { RendererProps } from "../fileKinds";
import { useRawBuffer } from "../useRawBuffer";
import { PreviewLoading, PreviewMessage } from "./PreviewStates";

const keepBuffer = (buffer: ArrayBuffer) => buffer;

export default function DocxView({ source, expanded }: RendererProps) {
  const state = useRawBuffer(source.url, keepBuffer);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failure, setFailure] = useState("");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (state.status !== "ready" || !bodyRef.current || !styleRef.current) return;
    let cancelled = false;
    setRendered(false);
    setFailure("");
    // Images are inlined as base64 because the site CSP does not allow blob: URLs.
    renderAsync(state.value, bodyRef.current, styleRef.current, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
    })
      .then(() => !cancelled && setRendered(true))
      .catch((cause) => !cancelled && setFailure(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [state]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!rendered || !scroller) return;
    const fit = () => {
      const page = bodyRef.current?.querySelector<HTMLElement>("section.docx");
      if (!page) return;
      const available = scroller.clientWidth - (expanded ? 64 : 24);
      setZoom(Math.min(expanded ? 1.15 : 1, available / page.offsetWidth));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [rendered, expanded]);

  if (state.status === "error" || failure) {
    return <PreviewMessage source={source} icon={FileWarning} title="文档无法解析" detail={failure || (state.status === "error" ? state.error : "")} />;
  }
  return (
    <div className="preview-scroll docx-scroll" ref={scrollRef}>
      {!rendered && <PreviewLoading label="正在排版文档" />}
      <div ref={styleRef} />
      <div ref={bodyRef} className="docx-host" style={{ zoom, opacity: rendered ? 1 : 0 }} />
    </div>
  );
}
