import {
  BookOpenText,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  NotebookText,
  Presentation,
  type LucideIcon,
} from "lucide-react";

export type FileKind =
  | "code"
  | "markdown"
  | "image"
  | "svg"
  | "pdf"
  | "slides"
  | "document"
  | "sheet"
  | "csv"
  | "audio"
  | "video"
  | "notebook"
  | "archive"
  | "binary";

interface KindInfo {
  label: string;
  icon: LucideIcon;
  tone: string;
  // Kinds whose readable text can also be shown as highlighted source.
  hasSource?: boolean;
  // Kinds rendered from /raw rather than the inline text payload.
  raw?: boolean;
}

export const kindInfo: Record<FileKind, KindInfo> = {
  code: { label: "代码", icon: FileCode2, tone: "code" },
  markdown: { label: "Markdown", icon: BookOpenText, tone: "markdown", hasSource: true },
  image: { label: "图片", icon: FileImage, tone: "image", raw: true },
  svg: { label: "SVG", icon: FileImage, tone: "image", hasSource: true, raw: true },
  pdf: { label: "PDF", icon: FileText, tone: "pdf", raw: true },
  slides: { label: "演示文稿", icon: Presentation, tone: "slides", raw: true },
  document: { label: "Word 文档", icon: FileText, tone: "document", raw: true },
  sheet: { label: "电子表格", icon: FileSpreadsheet, tone: "sheet", raw: true },
  csv: { label: "表格数据", icon: FileSpreadsheet, tone: "sheet", hasSource: true },
  audio: { label: "音频", icon: FileAudio, tone: "media", raw: true },
  video: { label: "视频", icon: FileVideo, tone: "media", raw: true },
  notebook: { label: "Jupyter", icon: NotebookText, tone: "notebook", hasSource: true },
  archive: { label: "压缩包", icon: FileArchive, tone: "binary", raw: true },
  binary: { label: "文件", icon: File, tone: "binary", raw: true },
};

const extensionKinds: Record<string, FileKind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  svg: "svg",
  pdf: "pdf",
  pptx: "slides",
  docx: "document",
  xlsx: "sheet", xlsm: "sheet", xls: "sheet", ods: "sheet",
  csv: "csv", tsv: "csv",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
  mp4: "video", webm: "video", mov: "video",
  ipynb: "notebook",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", "7z": "archive", rar: "archive", xz: "archive",
  ppt: "binary", doc: "binary", exe: "binary", dll: "binary", so: "binary", bin: "binary", woff: "binary", woff2: "binary",
  ttf: "binary", otf: "binary", class: "binary", jar: "binary", o: "binary", wasm: "binary", sqlite: "binary", db: "binary",
};

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileName(path: string): string {
  return path.split("/").pop() || path;
}

export function detectKind(path: string): FileKind {
  return extensionKinds[extensionOf(path)] ?? "code";
}

export function iconFor(path: string): LucideIcon {
  const extension = extensionOf(path);
  if (extension === "json" || extension === "jsonc") return FileJson;
  return kindInfo[detectKind(path)].icon;
}

export function rawUrl(projectId: string, path: string, options: { download?: boolean; version?: number } = {}): string {
  const query = new URLSearchParams({ path });
  if (options.download) query.set("download", "1");
  if (options.version) query.set("v", String(options.version));
  return `/api/projects/${projectId}/raw?${query}`;
}

export async function fetchRaw(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (response.status === 401) window.dispatchEvent(new Event("clinavat:unauthorized"));
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `文件读取失败 (${response.status})`);
  }
  return response.arrayBuffer();
}

// Resolves a link inside a previewed file against that file's directory; returns undefined when it leaves the project.
export function resolveProjectPath(fromFile: string, target: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(target)) return undefined;
  const clean = decodeURIComponent(target.split(/[?#]/)[0]);
  const parts = clean.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  for (const segment of clean.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/") || undefined;
}

export interface PreviewSource {
  projectId: string;
  path: string;
  size: number;
  mtime: number;
  url: string;
  content?: string;
}

export interface RendererProps {
  source: PreviewSource;
  expanded: boolean;
  showSource: boolean;
  wrap: boolean;
  onOpen: (path: string) => void;
}
