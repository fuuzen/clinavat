import DOMPurify from "dompurify";
import { marked } from "marked";
import type { SiteSettings } from "../../site/settings";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function interpolate(source: string, settings: SiteSettings, escape = false) {
  const values: Record<string, string> = {
    siteName: settings.name,
    logoUrl: settings.logo || `${import.meta.env.BASE_URL}clinavat.svg`,
    welcome: settings.welcome,
    description: settings.description,
  };
  return source.replace(/\{\{(siteName|logoUrl|welcome|description)\}\}/g,
    (_, key: string) => escape ? escapeHtml(values[key]) : values[key]);
}

export function contentHtml(source: string, settings: SiteSettings, options: { inline?: boolean; template?: boolean } = {}) {
  let content = interpolate(source, settings, true);
  if (options.template) content = content.replace("{{authForm}}", '<div data-clinavat-auth-slot=""></div>');
  const html = settings.login.contentFormat === "html" ? content
    : options.inline ? marked.parseInline(content, { gfm: true, breaks: true })
      : marked.parse(content, { gfm: true, breaks: true });
  const sanitized = DOMPurify.sanitize(String(html), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "form", "input", "button", "textarea", "select", "option", "iframe", "object", "embed", "link", "meta", "base"],
    FORBID_ATTR: ["srcdoc", "srcset", "action", "formaction", "contenteditable", "autofocus"],
    ADD_ATTR: ["target"],
  });
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  template.content.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    const source = image.getAttribute("src") || "";
    if (/^data:image\//i.test(source)) return;
    try {
      if (new URL(source, window.location.href).origin === window.location.origin) return;
    } catch { /* Invalid image URLs are removed with external URLs. */ }
    image.removeAttribute("src");
  });
  template.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    if (link.getAttribute("href")?.startsWith("#")) return;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
  return template.innerHTML;
}

export function RichContent({ content, settings, className = "", inline = false }: {
  content: string;
  settings: SiteSettings;
  className?: string;
  inline?: boolean;
}) {
  if (!content) return null;
  const html = contentHtml(content, settings, { inline });
  return inline
    ? <span className={`auth-rich-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
    : <div className={`auth-rich-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
