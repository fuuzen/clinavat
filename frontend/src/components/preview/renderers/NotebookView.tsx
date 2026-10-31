import { useMemo } from "react";
import { FileWarning } from "lucide-react";
import { Markdown } from "../../chat/MessageView";
import type { RendererProps } from "../fileKinds";
import { CodeBlock } from "./CodeView";
import { PreviewMessage } from "./PreviewStates";

type Text = string | string[] | undefined;
interface Output {
  output_type: string;
  name?: string;
  text?: Text;
  data?: Record<string, Text>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface Cell {
  cell_type: "code" | "markdown" | "raw";
  source: Text;
  execution_count?: number | null;
  outputs?: Output[];
}
interface Notebook {
  cells?: Cell[];
  metadata?: { kernelspec?: { display_name?: string; language?: string }; language_info?: { name?: string } };
}

const join = (value: Text) => (Array.isArray(value) ? value.join("") : value ?? "");
const stripAnsi = (value: string) => value.replace(/\x1b\[[\d;]*m/g, "");

function OutputView({ output }: { output: Output }) {
  if (output.output_type === "stream") {
    return <pre className={`notebook-stream${output.name === "stderr" ? " stderr" : ""}`}>{stripAnsi(join(output.text))}</pre>;
  }
  if (output.output_type === "error") {
    return <pre className="notebook-stream stderr">{stripAnsi(output.traceback?.join("\n") || `${output.ename}: ${output.evalue}`)}</pre>;
  }
  const data = output.data ?? {};
  for (const type of ["image/png", "image/jpeg", "image/gif"]) {
    if (data[type]) return <img className="notebook-image" src={`data:${type};base64,${join(data[type]).replace(/\s/g, "")}`} alt="" />;
  }
  if (data["image/svg+xml"]) {
    return <img className="notebook-image" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(join(data["image/svg+xml"]))}`} alt="" />;
  }
  if (data["text/markdown"]) return <Markdown text={join(data["text/markdown"])} />;
  // HTML outputs (rich tables, widgets) are not executed; their plain-text fallback is shown instead.
  if (data["text/plain"]) return <pre className="notebook-stream">{stripAnsi(join(data["text/plain"]))}</pre>;
  return null;
}

export default function NotebookView({ source, showSource, wrap }: RendererProps) {
  const content = source.content ?? "";
  const notebook = useMemo(() => {
    try {
      return JSON.parse(content) as Notebook;
    } catch {
      return undefined;
    }
  }, [content]);
  if (showSource) {
    return (
      <div className="preview-scroll">
        <CodeBlock code={content} language="json" numbered wrap={wrap} />
      </div>
    );
  }
  if (!notebook?.cells) return <PreviewMessage source={source} icon={FileWarning} title="Notebook 格式无效" detail="文件不是有效的 Jupyter Notebook JSON。" />;
  const language = notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? "python";
  return (
    <div className="preview-scroll">
      <div className="notebook">
        {notebook.metadata?.kernelspec?.display_name && <span className="notebook-kernel">{notebook.metadata.kernelspec.display_name}</span>}
        {notebook.cells.map((cell, index) =>
          cell.cell_type === "markdown" ? (
            <section key={index} className="notebook-cell markdown-cell">
              <Markdown text={join(cell.source)} />
            </section>
          ) : (
            <section key={index} className="notebook-cell code-cell">
              <span className="notebook-prompt">[{cell.execution_count ?? " "}]</span>
              <div className="notebook-input">
                <CodeBlock code={join(cell.source)} language={cell.cell_type === "code" ? language : undefined} wrap={wrap} />
              </div>
              {!!cell.outputs?.length && (
                <div className="notebook-outputs">
                  {cell.outputs.map((output, outputIndex) => (
                    <OutputView key={outputIndex} output={output} />
                  ))}
                </div>
              )}
            </section>
          ),
        )}
      </div>
    </div>
  );
}
