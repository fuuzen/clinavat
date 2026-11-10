import DOMPurify from "dompurify";
import flowchart from "flowchart.js";
import type { DiagramPalette } from "./render";

export function renderFlowchart(code: string, palette: DiagramPalette): string {
  const chart = flowchart.parse(code);
  if (!(chart as { start?: unknown }).start) throw new Error("流程图需要一个 start 节点，例如：st=>start: 开始");
  // Raphaël measures text while drawing, so the chart needs a laid-out container, even an invisible one.
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
  document.body.append(host);
  try {
    chart.drawSVG(host, {
      "line-width": 1.5,
      "line-length": 40,
      "text-margin": 10,
      "font-size": 13,
      "font-family": palette.font,
      "font-color": palette.text,
      "line-color": palette.muted,
      "element-color": palette.accent,
      fill: palette.accentDim,
      "yes-text": "是",
      "no-text": "否",
      "arrow-end": "block",
      scale: 1,
    });
    if (!host.querySelector("svg")) throw new Error("没有可绘制的流程图节点");
    // flowchart.js turns node links into SVG anchors; sanitizing drops script URLs and anything else unexpected.
    return DOMPurify.sanitize(host.innerHTML, { USE_PROFILES: { svg: true, svgFilters: true } });
  } finally {
    host.remove();
  }
}
