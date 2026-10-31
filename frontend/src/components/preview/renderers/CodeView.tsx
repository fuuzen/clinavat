import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { FileX2 } from "lucide-react";
import { highlight, languageFor } from "../highlight";
import type { RendererProps } from "../fileKinds";
import { PreviewMessage } from "./PreviewStates";

interface CodeBlockProps {
  code: string;
  language?: string;
  numbered?: boolean;
  wrap?: boolean;
}

export function CodeBlock({ code, language, numbered = false, wrap = false }: CodeBlockProps) {
  const [html, setHtml] = useState<string>();
  const trimmed = code.replace(/\n$/, "");
  useEffect(() => {
    let cancelled = false;
    setHtml(undefined);
    highlight(trimmed, language)
      // Shiki separates line spans with newlines; dropping them lets each line be a block with its own gutter.
      .then((result) => !cancelled && setHtml(result?.replace(/<\/span>\n<span class="line">/g, '</span><span class="line">')))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trimmed, language]);
  const lines = useMemo(() => trimmed.split("\n"), [trimmed]);
  const lineCount = lines.length;
  const className = `code-block${numbered ? " numbered" : ""}${wrap ? " wrap" : ""}`;
  const style = { "--gutter": `${String(lineCount).length + 2.4}ch` } as CSSProperties;
  if (html) return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <div className={className} style={style}>
      <pre className="shiki">
        <code>
          {lines.map((line, index) => (
            <span className="line" key={index}>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export default function CodeView({ source, wrap }: RendererProps) {
  const code = source.content ?? "";
  if (!code) return <PreviewMessage source={source} icon={FileX2} title="这是一个空文件" />;
  return (
    <div className="preview-scroll">
      <CodeBlock code={code} language={languageFor(source.path)} numbered wrap={wrap} />
    </div>
  );
}
