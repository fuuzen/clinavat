import { Children, isValidElement, type ReactNode } from "react";

export type DiagramKind = "mermaid" | "flowchart";

export interface DiagramSource {
  kind: DiagramKind;
  code: string;
}

// Typora-style ```flow fences hold flowchart.js, but Mermaid flowcharts are often fenced as ```flowchart too;
// a Mermaid diagram declares its type on the first line, after optional comments and front matter.
const mermaidHeader = new RegExp(
  "^(?:\\s*%%[^\\n]*\\n)*\\s*(?:---\\n[\\s\\S]*?\\n---\\s*)?(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey|xychart|block|packet|kanban|architecture|radar|treemap|zenuml|C4[A-Z]\\w*)\\b",
);

/** The diagram in a fenced code block, given the children react-markdown passes to its `pre` element. */
export function diagramFence(children: ReactNode): DiagramSource | undefined {
  const code = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(code)) return undefined;
  const language = /language-([\w+-]+)/.exec(code.props.className ?? "")?.[1]?.toLowerCase();
  const raw = code.props.children;
  const source = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).replace(/\n$/, "");
  if (language === "mermaid") return { kind: "mermaid", code: source };
  if (language === "flow" || language === "flowchart") return { kind: mermaidHeader.test(source) ? "mermaid" : "flowchart", code: source };
  return undefined;
}
