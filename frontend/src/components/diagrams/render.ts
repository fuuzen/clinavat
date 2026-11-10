import type { DiagramKind } from "./fence";

export interface DiagramPalette {
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  accentDim: string;
  font: string;
}

// Diagrams are drawn as static SVG, so the current appearance preset is read from its CSS variables at render time.
function currentPalette(): DiagramPalette {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    dark: root.dataset.themeMode !== "light",
    background: color("--panel"),
    surface: color("--surface"),
    text: color("--text"),
    muted: color("--muted"),
    line: color("--line-strong"),
    accent: color("--accent"),
    accentDim: color("--accent-dim"),
    font: style.fontFamily,
  };
}

/** Returns sanitized SVG markup. The renderers load on first use; Mermaid alone is several hundred kilobytes. */
export async function renderDiagram(kind: DiagramKind, code: string): Promise<string> {
  const palette = currentPalette();
  if (kind === "mermaid") return (await import("./mermaid")).renderMermaid(code, palette);
  return (await import("./flowchart")).renderFlowchart(code, palette);
}
