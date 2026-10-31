import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { defaultThemePreferences, getThemePalette, themePresets } from "../../theme";
import type { SiteSettings } from "../../site/settings";
import baseCss from "../../styles/base.css?inline";
import authCss from "../../styles/auth.css?inline";
import { interpolate } from "./content";

const frameDocument = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'"></head><body><div id="auth-root"></div></body></html>`;

export default function AuthFrame({ settings, preview, children }: {
  settings: SiteSettings;
  preview: boolean;
  children: ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [document, setDocument] = useState<Document | null>(null);
  useEffect(() => {
    if (!document) return;
    const style = document.createElement("style");
    style.textContent = `${baseCss}\n${authCss}`;
    document.head.append(style);
    return () => { style.remove(); };
  }, [document]);
  useEffect(() => {
    if (!document) return;
    const theme = themePresets.find((preset) => preset.id === settings.theme) || themePresets[0];
    const palette = getThemePalette({ ...defaultThemePreferences, presetId: theme.id });
    Object.entries(palette).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    document.documentElement.style.colorScheme = theme.mode;
    document.title = interpolate(settings.login.texts.frameTitle, settings);
  }, [document, settings.theme, settings.login.texts.frameTitle, settings.name]);
  useEffect(() => {
    if (!document) return;
    const style = document.createElement("style");
    // Assigning textContent keeps CSS in its own node even when it contains HTML delimiters.
    style.textContent = settings.login.customCss;
    document.head.append(style);
    return () => { style.remove(); };
  }, [document, settings.login.customCss]);

  return <iframe
    ref={frame}
    className={`auth-frame${preview ? " auth-frame-preview" : ""}`}
    title={interpolate(settings.login.texts.frameTitle, settings)}
    // No sandbox: WebKit skips event listeners on nodes in script-disabled frames, which breaks the
    // portaled React form. Untrusted content is constrained by DOMPurify and the frame CSP instead.
    srcDoc={frameDocument}
    onLoad={() => setDocument(frame.current?.contentDocument || null)}
    style={{ display: "block", width: "100%", height: preview ? "680px" : "100dvh", border: 0 }}
  >
    {document?.getElementById("auth-root") && createPortal(children, document.getElementById("auth-root")!)}
  </iframe>;
}
