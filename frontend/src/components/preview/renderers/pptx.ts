import JSZip from "jszip";

export interface TextRun {
  text: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
}

export interface Paragraph {
  align: "left" | "center" | "right" | "justify";
  level: number;
  bullet?: string;
  lineHeight?: number;
  size?: number;
  runs: TextRun[];
}

export interface SlideElement {
  kind: "shape" | "image" | "table" | "unsupported";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  fill?: string;
  border?: { color: string; width: number };
  geometry?: "ellipse" | "round" | "line";
  paragraphs?: Paragraph[];
  anchor?: "start" | "center" | "end";
  insets?: [number, number, number, number];
  fontScale?: number;
  image?: string;
  rows?: string[][];
  label?: string;
}

export interface Slide {
  background?: string;
  elements: SlideElement[];
  notes?: string;
}

export interface Deck {
  width: number;
  height: number;
  slides: Slide[];
}

type Style = { size?: number; color?: string; bullet?: string; bold?: boolean };
type Part = { path: string; doc: Document; rels: Record<string, string> };
interface Context {
  zip: JSZip;
  colors: Record<string, string>;
  fonts: { major: string; minor: string };
  styles: Record<"title" | "body" | "other", Style[]>;
  media: Map<string, Promise<string | undefined>>;
}

const parser = new DOMParser();
const children = (node: Element | null | undefined, name?: string) =>
  node ? [...node.children].filter((child) => !name || child.localName === name) : [];
const child = (node: Element | null | undefined, ...path: string[]) =>
  path.reduce<Element | undefined>((current, name) => children(current, name)[0], node ?? undefined);
const descendant = (node: Element | Document | null | undefined, name: string) =>
  node ? (node.getElementsByTagNameNS("*", name)[0] as Element | undefined) : undefined;
const number = (node: Element | undefined, attribute: string) => {
  const value = node?.getAttribute(attribute);
  return value === null || value === undefined ? undefined : Number(value);
};

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

async function readPart(zip: JSZip, path: string): Promise<Part | undefined> {
  const xml = await zip.file(path)?.async("text");
  if (!xml) return undefined;
  const relsPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsXml = await zip.file(relsPath)?.async("text");
  const rels: Record<string, string> = {};
  if (relsXml) {
    for (const rel of parser.parseFromString(relsXml, "application/xml").getElementsByTagNameNS("*", "Relationship")) {
      if (rel.getAttribute("TargetMode") !== "External") rels[rel.getAttribute("Id")!] = resolvePath(path, rel.getAttribute("Target")!);
    }
  }
  return { path, doc: parser.parseFromString(xml, "application/xml"), rels };
}

function adjust(hex: string, modifiers: Element[]): string {
  let [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  let alpha = 1;
  const value = (node: Element) => Number(node.getAttribute("val")) / 100000;
  for (const modifier of modifiers) {
    const amount = value(modifier);
    if (modifier.localName === "alpha") alpha = amount;
    else if (modifier.localName === "shade") [r, g, b] = [r, g, b].map((channel) => channel * amount);
    else if (modifier.localName === "tint") [r, g, b] = [r, g, b].map((channel) => channel + (1 - channel) * (1 - amount));
    else if (modifier.localName === "lumMod" || modifier.localName === "lumOff") {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let lightness = (max + min) / 2;
      const delta = max - min;
      const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
      let hue = 0;
      if (delta) hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      lightness = modifier.localName === "lumMod" ? lightness * amount : lightness + amount;
      lightness = Math.min(1, Math.max(0, lightness));
      const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
      const x = chroma * (1 - Math.abs((hue % 2) - 1));
      const m = lightness - chroma / 2;
      const sector = Math.floor((hue + 6) % 6);
      [r, g, b] = ([[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][sector] ?? [0, 0, 0])
        .map((channel) => channel + m);
    }
  }
  const [red, green, blue] = [r, g, b].map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255));
  return alpha < 1 ? `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(2)})` : `rgb(${red}, ${green}, ${blue})`;
}

const schemeAliases: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
function color(node: Element | undefined, context: Context): string | undefined {
  const source = node && ["srgbClr", "schemeClr", "sysClr", "prstClr"].includes(node.localName) ? node
    : children(node).find((item) => ["srgbClr", "schemeClr", "sysClr", "prstClr"].includes(item.localName));
  if (!source) return undefined;
  const value = source.getAttribute("val") ?? "";
  const hex = source.localName === "srgbClr" ? value
    : source.localName === "sysClr" ? source.getAttribute("lastClr") ?? "000000"
      : source.localName === "schemeClr" ? context.colors[schemeAliases[value] ?? value] ?? context.colors.dk1 ?? "000000"
        : undefined;
  return hex ? adjust(hex, children(source)) : value;
}

function fill(properties: Element | undefined, context: Context): string | undefined {
  const solid = child(properties, "solidFill");
  if (solid) return color(solid, context);
  const gradient = child(properties, "gradFill");
  if (!gradient) return undefined;
  const stops = children(child(gradient, "gsLst"), "gs").map((stop) => `${color(stop, context)} ${(number(stop, "pos") ?? 0) / 1000}%`);
  const angle = (number(child(gradient, "lin"), "ang") ?? 0) / 60000 + 90;
  return stops.length ? `linear-gradient(${angle}deg, ${stops.join(", ")})` : undefined;
}

function font(typeface: string | undefined | null, context: Context): string | undefined {
  if (!typeface) return undefined;
  if (typeface.startsWith("+mj")) return context.fonts.major;
  if (typeface.startsWith("+mn")) return context.fonts.minor;
  return typeface;
}

function textStyles(master: Part | undefined, context: Context): Context["styles"] {
  const styles: Context["styles"] = { title: [], body: [], other: [] };
  const text = descendant(master?.doc, "txStyles");
  for (const [key, name] of [["title", "titleStyle"], ["body", "bodyStyle"], ["other", "otherStyle"]] as const) {
    styles[key] = Array.from({ length: 9 }, (_, level) => {
      const paragraph = child(text, name, `lvl${level + 1}pPr`);
      const run = child(paragraph, "defRPr");
      const bullet = child(paragraph, "buChar")?.getAttribute("char") ?? undefined;
      return { size: (number(run, "sz") ?? 0) / 100 || undefined, color: color(child(run, "solidFill"), context), bullet, bold: run?.getAttribute("b") === "1" };
    });
  }
  return styles;
}

function placeholderKey(shape: Element) {
  const placeholder = descendant(child(shape, "nvSpPr") ?? child(shape, "nvPicPr") ?? shape, "ph");
  if (!placeholder) return undefined;
  return { type: placeholder.getAttribute("type") ?? "body", index: placeholder.getAttribute("idx") ?? undefined };
}

// Placeholders inherit geometry and text properties from the matching shape on the slide layout, then the master.
function inherited(shape: Element, layout: Part | undefined, master: Part | undefined): Element[] {
  const key = placeholderKey(shape);
  if (!key) return [shape];
  const chain = [shape];
  const masterType = key.type === "ctrTitle" ? "title" : key.type === "subTitle" ? "body" : key.type;
  for (const [part, type] of [[layout, key.type], [master, masterType]] as const) {
    const shapes = part ? [...part.doc.getElementsByTagNameNS("*", "sp")] : [];
    const match = shapes.find((candidate) => key.index && placeholderKey(candidate)?.index === key.index)
      ?? shapes.find((candidate) => placeholderKey(candidate)?.type === type);
    if (match) chain.push(match);
  }
  return chain;
}

async function media(part: Part, id: string | null, context: Context): Promise<string | undefined> {
  const path = id ? part.rels[id] : undefined;
  if (!path) return undefined;
  if (!context.media.has(path)) {
    const extension = path.split(".").pop()!.toLowerCase();
    const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" };
    const type = types[extension];
    context.media.set(path, type ? context.zip.file(path)?.async("base64").then((data) => `data:${type};base64,${data}`) ?? Promise.resolve(undefined) : Promise.resolve(undefined));
  }
  return context.media.get(path);
}

function paragraphs(body: Element, chain: Element[], kind: "title" | "body" | "other", context: Context, styledColor?: string): Paragraph[] {
  const placeholder = chain.length > 1;
  return children(body, "p").map((paragraph) => {
    const properties = child(paragraph, "pPr");
    const level = number(properties, "lvl") ?? 0;
    const style = context.styles[kind][level] ?? {};
    const align = ({ ctr: "center", r: "right", just: "justify" } as const)[properties?.getAttribute("algn") as "ctr"] ?? "left";
    const bullet = child(properties, "buNone") ? undefined
      : child(properties, "buChar")?.getAttribute("char") ?? (child(properties, "buAutoNum") ? "•" : placeholder && kind === "body" ? style.bullet : undefined);
    const spacing = number(child(properties, "lnSpc", "spcPct"), "val");
    const runs: TextRun[] = [];
    for (const node of children(paragraph)) {
      if (node.localName === "br") runs.push({ text: "\n" });
      if (node.localName !== "r" && node.localName !== "fld") continue;
      const run = child(node, "rPr");
      runs.push({
        text: child(node, "t")?.textContent ?? "",
        size: (number(run, "sz") ?? 0) / 100 || style.size,
        bold: run?.hasAttribute("b") ? run.getAttribute("b") === "1" : style.bold,
        italic: run?.getAttribute("i") === "1",
        underline: !!run?.getAttribute("u") && run.getAttribute("u") !== "none",
        strike: !!run?.getAttribute("strike") && run.getAttribute("strike") !== "noStrike",
        color: color(child(run, "solidFill"), context) ?? styledColor ?? style.color,
        font: font(child(run, "latin")?.getAttribute("typeface") ?? child(run, "ea")?.getAttribute("typeface"), context)
          || (kind === "title" ? context.fonts.major : context.fonts.minor) || undefined,
      });
    }
    const end = (number(child(paragraph, "endParaRPr"), "sz") ?? 0) / 100;
    return { align, level, bullet: runs.some((run) => run.text.trim()) ? bullet : undefined, lineHeight: spacing ? spacing / 100000 : undefined, size: end || style.size, runs };
  });
}

type Transform = (x: number, y: number, width: number, height: number) => [number, number, number, number];
const identity: Transform = (...box) => box;

function geometry(transform: Element | undefined, map: Transform) {
  const offset = child(transform, "off");
  const extent = child(transform, "ext");
  if (!offset || !extent) return undefined;
  const [x, y, width, height] = map(number(offset, "x") ?? 0, number(offset, "y") ?? 0, number(extent, "cx") ?? 0, number(extent, "cy") ?? 0);
  return { x, y, width, height, rotation: (number(transform, "rot") ?? 0) / 60000, flipH: transform?.getAttribute("flipH") === "1", flipV: transform?.getAttribute("flipV") === "1" };
}

async function elements(nodes: Element[], part: Part, layout: Part | undefined, master: Part | undefined, context: Context, map: Transform): Promise<SlideElement[]> {
  const result: SlideElement[] = [];
  for (const node of nodes) {
    if (node.localName === "AlternateContent") {
      result.push(...(await elements(children(child(node, "Fallback") ?? child(node, "Choice")), part, layout, master, context, map)));
    } else if (node.localName === "grpSp") {
      const transform = child(node, "grpSpPr", "xfrm");
      const [offset, extent, childOffset, childExtent] = ["off", "ext", "chOff", "chExt"].map((name) => child(transform, name));
      const scaleX = (number(extent, "cx") ?? 1) / (number(childExtent, "cx") || 1);
      const scaleY = (number(extent, "cy") ?? 1) / (number(childExtent, "cy") || 1);
      const local: Transform = (x, y, width, height) => map(
        (number(offset, "x") ?? 0) + (x - (number(childOffset, "x") ?? 0)) * scaleX,
        (number(offset, "y") ?? 0) + (y - (number(childOffset, "y") ?? 0)) * scaleY,
        width * scaleX, height * scaleY);
      result.push(...(await elements(children(node), part, layout, master, context, local)));
    } else if (node.localName === "sp" || node.localName === "cxnSp") {
      const chain = inherited(node, layout, master);
      const box = chain.map((shape) => geometry(child(shape, "spPr", "xfrm"), map)).find(Boolean);
      if (!box) continue;
      const properties = child(node, "spPr");
      const style = child(node, "style");
      const preset = child(properties, "prstGeom")?.getAttribute("prst") ?? "rect";
      const line = child(properties, "ln");
      const lineColor = child(line, "noFill") ? undefined : color(child(line, "solidFill"), context)
        ?? (number(child(style, "lnRef"), "idx") ? color(child(style, "lnRef"), context) : undefined);
      const key = placeholderKey(node);
      const kind = !key ? "other" : ["title", "ctrTitle"].includes(key.type) ? "title" : ["body", "subTitle", "obj"].includes(key.type) ? "body" : "other";
      const body = chain.map((shape) => child(shape, "txBody", "bodyPr")).filter(Boolean) as Element[];
      const insets = (["tIns", "rIns", "bIns", "lIns"] as const).map((name, index) => number(body.find((item) => item.hasAttribute(name)), name) ?? (index % 2 ? 91440 : 45720)) as SlideElement["insets"];
      const anchor = body.map((item) => item.getAttribute("anchor")).find(Boolean);
      const text = child(node, "txBody");
      result.push({
        kind: "shape",
        ...box,
        fill: child(properties, "noFill") ? undefined : fill(properties, context) ?? (number(child(style, "fillRef"), "idx") ? color(child(style, "fillRef"), context) : undefined),
        border: lineColor ? { color: lineColor, width: number(line, "w") ?? 12700 } : undefined,
        geometry: preset === "ellipse" ? "ellipse" : preset.startsWith("round") ? "round" : node.localName === "cxnSp" || preset === "line" ? "line" : undefined,
        paragraphs: text ? paragraphs(text, chain, kind, context, color(child(style, "fontRef"), context)) : undefined,
        anchor: anchor === "ctr" ? "center" : anchor === "b" ? "end" : "start",
        insets,
        fontScale: (number(child(body[0], "normAutofit"), "fontScale") ?? 100000) / 100000,
      });
    } else if (node.localName === "pic") {
      const box = inherited(node, layout, master).map((shape) => geometry(child(shape, "spPr", "xfrm"), map)).find(Boolean);
      if (!box) continue;
      const image = await media(part, descendant(node, "blip")?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? null, context);
      result.push(image ? { kind: "image", ...box, image } : { kind: "unsupported", ...box, label: "图片格式不支持预览" });
    } else if (node.localName === "graphicFrame") {
      const box = geometry(child(node, "xfrm"), map);
      if (!box) continue;
      const table = descendant(node, "tbl");
      const uri = descendant(node, "graphicData")?.getAttribute("uri") ?? "";
      if (table) {
        result.push({ kind: "table", ...box, rows: children(table, "tr").map((row) => children(row, "tc").map((cell) => [...cell.getElementsByTagNameNS("*", "t")].map((item) => item.textContent).join(""))) });
      } else {
        result.push({ kind: "unsupported", ...box, label: uri.includes("chart") ? "图表" : uri.includes("diagram") ? "SmartArt 图形" : "嵌入对象" });
      }
    }
  }
  return result;
}

async function background(parts: (Part | undefined)[], context: Context): Promise<string | undefined> {
  for (const part of parts) {
    const node = descendant(part?.doc, "bg");
    if (!node || !part) continue;
    const properties = child(node, "bgPr");
    const image = child(properties, "blipFill");
    if (image) {
      const url = await media(part, descendant(image, "blip")?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? null, context);
      if (url) return `center / cover no-repeat url("${url}")`;
    }
    const value = properties ? fill(properties, context) : color(child(node, "bgRef"), context);
    if (value) return value;
  }
  return undefined;
}

export async function parsePptx(buffer: ArrayBuffer): Promise<Deck> {
  const zip = await JSZip.loadAsync(buffer);
  const presentation = await readPart(zip, "ppt/presentation.xml");
  if (!presentation) throw new Error("不是有效的 PowerPoint 文件");
  const size = descendant(presentation.doc, "sldSz");
  const themePath = Object.values(presentation.rels).find((path) => /theme\/theme\d*\.xml$/.test(path));
  const theme = themePath ? await readPart(zip, themePath) : undefined;
  const context: Context = { zip, colors: {}, fonts: { major: "", minor: "" }, styles: { title: [], body: [], other: [] }, media: new Map() };
  for (const entry of children(descendant(theme?.doc, "clrScheme"))) {
    context.colors[entry.localName] = child(entry, "srgbClr")?.getAttribute("val") ?? child(entry, "sysClr")?.getAttribute("lastClr") ?? "000000";
  }
  context.fonts = {
    major: child(descendant(theme?.doc, "majorFont"), "latin")?.getAttribute("typeface") ?? "",
    minor: child(descendant(theme?.doc, "minorFont"), "latin")?.getAttribute("typeface") ?? "",
  };
  const parts = new Map<string, Promise<Part | undefined>>();
  const load = (path: string | undefined) => {
    if (!path) return Promise.resolve(undefined);
    if (!parts.has(path)) parts.set(path, readPart(zip, path));
    return parts.get(path)!;
  };
  // Non-placeholder shapes on the master and layout (logos, colour bars) appear beneath every slide that shows them.
  const decorations = new Map<string, Promise<SlideElement[]>>();
  const decorate = (part: Part | undefined) => {
    if (!part) return Promise.resolve([]);
    if (!decorations.has(part.path)) {
      const shapes = children(descendant(part.doc, "spTree")).filter((node) => !placeholderKey(node));
      decorations.set(part.path, elements(shapes, part, undefined, undefined, context, identity));
    }
    return decorations.get(part.path)!;
  };
  const ids = children(descendant(presentation.doc, "sldIdLst"), "sldId")
    .map((node) => node.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
  const slides: Slide[] = [];
  for (const id of ids) {
    const slide = await load(id ? presentation.rels[id] : undefined);
    if (!slide) continue;
    const relation = (part: Part | undefined, pattern: RegExp) => part && Object.values(part.rels).find((path) => pattern.test(path));
    const layout = await load(relation(slide, /slideLayouts\//));
    const master = await load(relation(layout, /slideMasters\//));
    if (!context.styles.title.length) context.styles = textStyles(master, context);
    const notes = await load(relation(slide, /notesSlides\//));
    const notesBody = notes && [...notes.doc.getElementsByTagNameNS("*", "sp")].find((shape) => placeholderKey(shape)?.type === "body");
    slides.push({
      background: await background([slide, layout, master], context),
      elements: [
        ...(slide.doc.documentElement.getAttribute("showMasterSp") === "0" ? [] : [
          ...(layout?.doc.documentElement.getAttribute("showMasterSp") === "0" ? [] : await decorate(master)),
          ...(await decorate(layout)),
        ]),
        ...(await elements(children(descendant(slide.doc, "spTree")), slide, layout, master, context, identity)),
      ],
      notes: notesBody ? children(child(notesBody, "txBody"), "p").map((paragraph) => [...paragraph.getElementsByTagNameNS("*", "t")].map((item) => item.textContent).join("")).join("\n").trim() || undefined : undefined,
    });
  }
  return { width: number(size, "cx") ?? 12192000, height: number(size, "cy") ?? 6858000, slides };
}
