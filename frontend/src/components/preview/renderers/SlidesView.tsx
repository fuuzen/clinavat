import { memo, useCallback, useEffect, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, MessageSquareText, Play, Presentation, Shapes } from "lucide-react";
import type { RendererProps } from "../fileKinds";
import { PageIndicator, ViewerControls } from "../PreviewToolbar";
import { useRawBuffer } from "../useRawBuffer";
import { parsePptx, type Deck, type Paragraph, type Slide, type SlideElement } from "./pptx";
import { PreviewLoading, PreviewMessage } from "./PreviewStates";

// Slides are laid out on a fixed 960px canvas and scaled as a whole, so text wraps exactly as it would at full size.
const canvasWidth = 960;
const pointInEmu = 12700;

function useElementSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

function TextBody({ paragraphs, unit, fontScale }: { paragraphs: Paragraph[]; unit: number; fontScale: number }) {
  const px = (points: number | undefined) => (points ?? 18) * pointInEmu * unit * fontScale;
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p
          key={index}
          style={{
            textAlign: paragraph.align,
            fontSize: px(paragraph.size ?? paragraph.runs[0]?.size),
            lineHeight: (paragraph.lineHeight ?? 1) * 1.18,
            paddingLeft: `calc(${paragraph.level * 0.42 * 914400 * unit}px + ${paragraph.bullet ? "1.1em" : "0px"})`,
          }}
        >
          {paragraph.bullet && <span className="slide-bullet">{paragraph.bullet}</span>}
          {paragraph.runs.length === 0 && " "}
          {paragraph.runs.map((run, runIndex) =>
            run.text === "\n" ? (
              <br key={runIndex} />
            ) : (
              <span
                key={runIndex}
                style={{
                  fontSize: px(run.size ?? paragraph.size),
                  fontWeight: run.bold ? 700 : undefined,
                  fontStyle: run.italic ? "italic" : undefined,
                  textDecoration: [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ") || undefined,
                  color: run.color,
                  fontFamily: run.font ? `"${run.font}", var(--slide-font)` : undefined,
                }}
              >
                {run.text}
              </span>
            ),
          )}
        </p>
      ))}
    </>
  );
}

function SlideElementView({ element, unit }: { element: SlideElement; unit: number }) {
  const width = element.width * unit;
  const height = element.height * unit;
  const style: CSSProperties = {
    left: element.x * unit,
    top: element.y * unit,
    width,
    height,
    transform: element.rotation || element.flipH || element.flipV
      ? `rotate(${element.rotation ?? 0}deg) scale(${element.flipH ? -1 : 1}, ${element.flipV ? -1 : 1})`
      : undefined,
  };
  if (element.kind === "image") return <img className="slide-element" style={style} src={element.image} alt="" draggable={false} />;
  if (element.kind === "unsupported") {
    return (
      <div className="slide-element slide-unsupported" style={style}>
        <Shapes size={Math.max(14, Math.min(36, height / 4))} />
        <span>{element.label}</span>
      </div>
    );
  }
  if (element.kind === "table") {
    return (
      <div className="slide-element" style={style}>
        <table className="slide-table">
          <tbody>
            {element.rows?.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (element.geometry === "line") {
    const stroke = element.border?.width ? Math.max(1, element.border.width * unit) : 1;
    return (
      <svg className="slide-element" style={{ ...style, overflow: "visible", transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined }}>
        <line
          x1={element.flipH ? width : 0}
          y1={element.flipV ? height : 0}
          x2={element.flipH ? 0 : width}
          y2={element.flipV ? 0 : height}
          stroke={element.border?.color ?? "currentColor"}
          strokeWidth={stroke}
        />
      </svg>
    );
  }
  const [top, right, bottom, left] = (element.insets ?? [45720, 91440, 45720, 91440]).map((inset) => inset * unit);
  return (
    <div
      className="slide-element slide-shape"
      style={{
        ...style,
        background: element.fill,
        border: element.border ? `${Math.max(1, element.border.width * unit)}px solid ${element.border.color}` : undefined,
        borderRadius: element.geometry === "ellipse" ? "50%" : element.geometry === "round" ? Math.min(width, height) * 0.16 : undefined,
        justifyContent: element.anchor,
        padding: `${top}px ${right}px ${bottom}px ${left}px`,
      }}
    >
      {element.paragraphs && <TextBody paragraphs={element.paragraphs} unit={unit} fontScale={element.fontScale ?? 1} />}
    </div>
  );
}

const SlideCanvas = memo(function SlideCanvas({ deck, slide, width }: { deck: Deck; slide: Slide; width: number }) {
  const unit = canvasWidth / deck.width;
  const height = (canvasWidth * deck.height) / deck.width;
  const scale = width / canvasWidth;
  return (
    <div className="slide-frame" style={{ width, height: height * scale }}>
      <div className="slide-canvas" style={{ width: canvasWidth, height, transform: `scale(${scale})`, background: slide.background ?? "#ffffff" }}>
        {slide.elements.map((element, index) => (
          <SlideElementView key={index} element={element} unit={unit} />
        ))}
      </div>
    </div>
  );
});

function DeckView({ deck, expanded }: { deck: Deck; expanded: boolean }) {
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const listSize = useElementSize(list);
  const stageSize = useElementSize(stage);
  const total = deck.slides.length;
  const aspect = deck.height / deck.width;
  const goTo = useCallback((index: number) => setCurrent(Math.min(total - 1, Math.max(0, index))), [total]);

  useEffect(() => {
    const onChange = () => setPresenting(document.fullscreenElement === stage && !!stage);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [stage]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) goTo(current + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) goTo(current - 1);
      else if (event.key === "Home") goTo(0);
      else if (event.key === "End") goTo(total - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, current, goTo, total]);
  useEffect(() => {
    document.querySelector(`.slides-rail [data-slide="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (!total) return <div className="preview-state"><Presentation size={22} /><p>演示文稿中没有幻灯片</p></div>;

  if (!expanded) {
    return (
      <div className="preview-scroll slides-list" ref={setList}>
        {listSize.width > 0 &&
          deck.slides.map((slide, index) => (
            <figure key={index}>
              <SlideCanvas deck={deck} slide={slide} width={listSize.width - 28} />
              <figcaption>{index + 1}</figcaption>
            </figure>
          ))}
      </div>
    );
  }
  const notes = deck.slides[current]?.notes;
  const fitWidth = presenting
    ? Math.min(window.innerWidth, window.innerHeight / aspect)
    : Math.max(0, Math.min(stageSize.width - 64, (stageSize.height - 64) / aspect));
  return (
    <div className="slides-expanded">
      <div className="slides-rail">
        {deck.slides.map((slide, index) => (
          <button key={index} data-slide={index} className={index === current ? "active" : ""} onClick={() => goTo(index)}>
            <span>{index + 1}</span>
            <SlideCanvas deck={deck} slide={slide} width={112} />
          </button>
        ))}
      </div>
      <div className="slides-main">
        <div
          className={`slides-stage${presenting ? " presenting" : ""}`}
          ref={setStage}
          onClick={() => presenting && goTo(current + 1)}
        >
          {fitWidth > 0 && <SlideCanvas deck={deck} slide={deck.slides[current]} width={fitWidth} />}
        </div>
        {notes && (
          <div className="slides-notes">
            <span>
              <MessageSquareText size={13} />
              演讲者备注
            </span>
            <p>{notes}</p>
          </div>
        )}
      </div>
      <ViewerControls>
        <button onClick={() => goTo(current - 1)} disabled={current === 0} aria-label="上一张" title="上一张">
          <ChevronLeft size={15} />
        </button>
        <PageIndicator page={current + 1} total={total} onChange={(page) => goTo(page - 1)} />
        <button onClick={() => goTo(current + 1)} disabled={current === total - 1} aria-label="下一张" title="下一张">
          <ChevronRight size={15} />
        </button>
        <i />
        <button className="viewer-text-button" onClick={() => void stage?.requestFullscreen()} title="全屏放映，方向键翻页，Esc 退出">
          <Play size={13} />
          放映
        </button>
      </ViewerControls>
    </div>
  );
}

export default function SlidesView({ source, expanded }: RendererProps) {
  const state = useRawBuffer(source.url, parsePptx);
  if (state.status === "loading") return <PreviewLoading label="正在解析演示文稿" />;
  if (state.status === "error") return <PreviewMessage source={source} title="演示文稿无法解析" detail={state.error} />;
  return <DeckView deck={state.value} expanded={expanded} />;
}
