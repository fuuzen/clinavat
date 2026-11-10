import type { Mermaid } from "mermaid";
import mermaidScript from "mermaid/dist/mermaid.min.js?url";
import type { DiagramPalette } from "./render";

declare global {
  interface Window {
    mermaid?: Mermaid;
  }
}

let loading: Promise<Mermaid> | undefined;
let sequence = 0;

// The prebuilt bundle is shipped as a file instead of being bundled: Mermaid's module graph alone exhausts the
// build's memory on a small host. It is loaded from the site's own origin, as the content security policy requires.
function loadMermaid(): Promise<Mermaid> {
  loading ??= new Promise<Mermaid>((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src: mermaidScript, async: true });
    script.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("Mermaid 加载失败")));
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(new Error("Mermaid 加载失败，请检查网络后重试"));
    };
    document.head.append(script);
  });
  return loading;
}

export async function renderMermaid(code: string, palette: DiagramPalette): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    // Diagrams come from agent output: strict mode sanitizes labels and the final SVG and drops click handlers.
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    fontFamily: palette.font,
    themeVariables: {
      darkMode: palette.dark,
      background: palette.background,
      fontFamily: palette.font,
      fontSize: "13px",
      primaryColor: palette.accentDim,
      primaryTextColor: palette.text,
      primaryBorderColor: palette.accent,
      secondaryColor: palette.surface,
      secondaryTextColor: palette.text,
      secondaryBorderColor: palette.line,
      tertiaryColor: palette.background,
      tertiaryTextColor: palette.text,
      tertiaryBorderColor: palette.line,
      lineColor: palette.muted,
      textColor: palette.text,
      mainBkg: palette.accentDim,
      nodeBorder: palette.accent,
      clusterBkg: palette.surface,
      clusterBorder: palette.line,
      titleColor: palette.text,
      edgeLabelBackground: palette.background,
      noteBkgColor: palette.surface,
      noteTextColor: palette.text,
      noteBorderColor: palette.line,
    },
  });
  // Mermaid queues renders internally, so diagrams rendering at once do not interleave.
  const { svg } = await mermaid.render(`clinavat-mermaid-${++sequence}`, code);
  return svg;
}
