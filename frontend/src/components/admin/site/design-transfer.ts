import { defaultSiteSettings, type SiteSettings } from "../../../site/settings";
import { themePresets } from "../../../theme";

function validImageSource(value: string) {
  if (!value) return true;
  if (value.startsWith("data:")) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[1].length % 4 !== 0) return false;
    const bytes = match[1].length * 3 / 4 - (match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0);
    return bytes <= 2 * 1024 * 1024;
  }
  return value.length <= 2048 && !/[\s\\\u0000-\u001f\u007f]/.test(value) && value.startsWith("/") && !value.startsWith("//");
}

function readKnownFields(template: unknown, source: unknown, path = "设计"): unknown {
  if (typeof template === "string" || typeof template === "boolean") {
    if (typeof source !== typeof template) throw new Error(`${path}格式无效。`);
    return source;
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${path}格式无效。`);
  const input = source as Record<string, unknown>;
  return Object.fromEntries(Object.entries(template as Record<string, unknown>).map(([key, initial]) =>
    [key, input[key] === undefined ? structuredClone(initial) : readKnownFields(initial, input[key], `${path}.${key}`)],
  ));
}

export function validateDesign(source: unknown): SiteSettings {
  const result = readKnownFields(defaultSiteSettings, source) as SiteSettings;
  if (!result.name.trim() || result.name.length > 80) throw new Error("站点名称需为 1–80 个字符。");
  if (!validImageSource(result.logo) || !validImageSource(result.favicon)) throw new Error("Logo 和浏览器图标必须为站内绝对路径，或不超过 2 MB 的 PNG、JPEG、WebP 图片。");
  if (!themePresets.some((preset) => preset.id === result.theme)) throw new Error("请选择有效的配色方案。");
  if (!["split", "centered", "custom"].includes(result.login.layout)) throw new Error("页面布局无效。");
  if (!["markdown", "html"].includes(result.login.contentFormat)) throw new Error("内容格式无效。");
  if (result.login.layout === "custom" && result.login.pageContent.split("{{authForm}}").length !== 2) throw new Error("整页内容中必须恰好保留一个 {{authForm}} 登录表单占位符。");
  if (result.welcome.length > 4000 || Object.values(result.login.texts).some((text) => text.length > 4000)) throw new Error("欢迎标语和单项文案最多支持 4000 个字符。");
  if ([result.description, result.login.storyContent, result.login.footerContent, result.login.customCss].some((text) => text.length > 65536) || result.login.pageContent.length > 131072) throw new Error("页面内容或 CSS 超过长度限制。");
  return result;
}

export async function parseDesignFile(file: File): Promise<SiteSettings> {
  if (file.size > 6 * 1024 * 1024) throw new Error("请选择不超过 6 MB 的设计 JSON 文件。");
  let source: unknown;
  try { source = JSON.parse(await file.text()); }
  catch { throw new Error("无法读取设计，请选择有效的 JSON 文件。"); }
  return validateDesign(source);
}

export function downloadDesign(settings: SiteSettings) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "site-design.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
