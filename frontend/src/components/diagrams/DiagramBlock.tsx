import { useEffect, useRef, useState } from "react";
import { Check, Code2, Copy, Eye, LoaderCircle, Maximize2, TriangleAlert, Workflow } from "lucide-react";
import { useTheme } from "../../theme";
import { Modal } from "../Dialogs";
import type { DiagramSource } from "./fence";
import { renderDiagram } from "./render";

const labels: Record<DiagramSource["kind"], string> = { mermaid: "Mermaid", flowchart: "flowchart.js" };
// A streamed reply changes the code on every token; waiting for a pause avoids rendering each partial diagram.
const settleMs = 250;

interface Rendering {
  svg?: string;
  error?: string;
  pending: boolean;
}

export default function DiagramBlock({ kind, code }: DiagramSource) {
  const { preferences } = useTheme();
  const [rendering, setRendering] = useState<Rendering>({ pending: true });
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const rendered = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setRendering((current) => ({ ...current, pending: true }));
    const timer = window.setTimeout(() => {
      renderDiagram(kind, code)
        .then((svg) => !cancelled && setRendering({ svg, pending: false }))
        // Keeping the last good drawing stops a diagram from flickering to an error while it is still being written.
        .catch((error: unknown) => !cancelled && setRendering((current) => ({
          svg: current.svg, error: error instanceof Error ? error.message : String(error), pending: false,
        })));
    }, rendered.current ? settleMs : 0);
    rendered.current = true;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kind, code, preferences]);

  async function copy() {
    await navigator.clipboard.writeText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const { svg, error, pending } = rendering;
  const drawing = svg && !showSource;
  return (
    <figure className="diagram-block">
      <figcaption className="diagram-toolbar">
        <Workflow size={13} />
        <span>{labels[kind]}</span>
        {pending && <LoaderCircle size={12} className="spin" aria-label="正在渲染" />}
        {error && svg && (
          <span className="diagram-stale" title={`最新内容无法渲染，显示的是上一次的结果：${error}`}>
            <TriangleAlert size={12} />
          </span>
        )}
        <div className="diagram-actions">
          {svg && (
            <button className="icon-button" onClick={() => setShowSource((value) => !value)} aria-label={showSource ? "查看图表" : "查看源码"} title={showSource ? "查看图表" : "查看源码"}>
              {showSource ? <Eye size={13} /> : <Code2 size={13} />}
            </button>
          )}
          {drawing && (
            <button className="icon-button" onClick={() => setZoomed(true)} aria-label="放大查看" title="放大查看">
              <Maximize2 size={13} />
            </button>
          )}
          <button className="icon-button" onClick={() => void copy()} aria-label="复制源码" title="复制源码">
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </figcaption>
      {drawing ? (
        <div className="diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <>
          {error && !svg && <p className="diagram-error">无法渲染图表：{error}</p>}
          <pre>
            <code>{code}</code>
          </pre>
        </>
      )}
      {zoomed && svg && (
        <Modal title={`${labels[kind]} 图表`} wide onClose={() => setZoomed(false)}>
          <div className="diagram-zoom" dangerouslySetInnerHTML={{ __html: svg }} />
        </Modal>
      )}
    </figure>
  );
}
