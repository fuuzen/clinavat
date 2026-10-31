import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff, ListTree } from "lucide-react";
import { rawUrl, resolveProjectPath, type RendererProps } from "../fileKinds";
import { languageFor } from "../highlight";
import { CodeBlock } from "./CodeView";

interface Heading {
  depth: number;
  text: string;
  id: string;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

function splitFrontMatter(markdown: string): { meta?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  return match ? { meta: match[1], body: markdown.slice(match[0].length) } : { body: markdown };
}

function outline(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "");
    headings.push({ depth: match[1].length, text, id: slug(text) });
  }
  return headings;
}

export default function MarkdownView({ source, expanded, showSource, wrap, onOpen }: RendererProps) {
  const markdown = source.content ?? "";
  const { meta, body } = useMemo(() => splitFrontMatter(markdown), [markdown]);
  const headings = useMemo(() => outline(body), [body]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeHeading, setActiveHeading] = useState("");
  const showOutline = expanded && headings.length > 2 && !showSource;

  useEffect(() => {
    const root = scrollRef.current;
    if (!showOutline || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveHeading(visible[0].target.id);
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    root.querySelectorAll("h1[id], h2[id], h3[id]").forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [showOutline, body]);

  const components = useMemo<Components>(() => {
    const heading = (Tag: "h1" | "h2" | "h3" | "h4") =>
      function Heading({ children }: { children?: ReactNode }) {
        return <Tag id={slug(textOf(children))}>{children}</Tag>;
      };
    return {
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      pre({ children }) {
        const child = Children.toArray(children)[0];
        if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
        const language = /language-([\w+-]+)/.exec(child.props.className ?? "")?.[1];
        return <CodeBlock code={textOf(child.props.children).replace(/\n$/, "")} language={language && languageFor(`x.${language}`) || language} />;
      },
      img({ src, alt }) {
        const target = typeof src === "string" ? src : "";
        if (/^data:image\//.test(target)) return <img src={target} alt={alt} />;
        const path = resolveProjectPath(source.path, target);
        // The site CSP only allows same-origin images, so external ones are shown as links instead of broken frames.
        if (!path) {
          return (
            <a className="markdown-external-image" href={target} target="_blank" rel="noreferrer">
              <ImageOff size={13} />
              {alt || "外部图片"}
            </a>
          );
        }
        return <img src={rawUrl(source.projectId, path)} alt={alt} loading="lazy" />;
      },
      a({ href, children }) {
        const target = href ?? "";
        if (target.startsWith("#")) {
          return (
            <a
              href={target}
              onClick={(event) => {
                event.preventDefault();
                scrollRef.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(target.slice(1)))}"]`)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {children}
            </a>
          );
        }
        const path = resolveProjectPath(source.path, target);
        if (path) {
          return (
            <a
              href={target}
              onClick={(event) => {
                event.preventDefault();
                onOpen(path);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={target} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    };
  }, [source.path, source.projectId, onOpen]);

  if (showSource) {
    return (
      <div className="preview-scroll">
        <CodeBlock code={markdown} language="markdown" numbered wrap={wrap} />
      </div>
    );
  }
  return (
    <div className={`markdown-preview${showOutline ? " with-outline" : ""}`}>
      <div className="preview-scroll" ref={scrollRef}>
        <article className="markdown preview-document">
          {meta && (
            <details className="markdown-front-matter">
              <summary>文档属性</summary>
              <CodeBlock code={meta} language="yaml" />
            </details>
          )}
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {body}
          </ReactMarkdown>
        </article>
      </div>
      {showOutline && (
        <nav className="markdown-outline" aria-label="文档大纲">
          <span>
            <ListTree size={13} />
            大纲
          </span>
          {headings.map((heading, index) => (
            <button
              key={`${heading.id}-${index}`}
              className={`depth-${heading.depth}${activeHeading === heading.id ? " active" : ""}`}
              onClick={() => scrollRef.current?.querySelector(`[id="${CSS.escape(heading.id)}"]`)?.scrollIntoView({ behavior: "smooth" })}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
