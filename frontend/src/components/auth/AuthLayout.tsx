import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, CircleDot, ShieldCheck, TerminalSquare } from "lucide-react";
import type { SiteSettings } from "../../site/settings";
import { contentHtml, RichContent } from "./content";

function LoginBrand({ settings }: { settings: SiteSettings }) {
  return <div className="brand">
    <span className="brand-mark"><img className="brand-logo" src={settings.logo || `${import.meta.env.BASE_URL}clinavat.svg`} alt="" aria-hidden="true" width={40} height={40} /></span>
    <span className="brand-wordmark" title={settings.name}>{settings.name}</span>
  </div>;
}

function FeaturePreview({ settings }: { settings: SiteSettings }) {
  const texts = settings.login.texts;
  return <div className="auth-preview">
    <div className="preview-bar"><span /><span /><span /><small><RichContent content={texts.previewTitle} settings={settings} inline /></small></div>
    {texts.previewEnvironment && <div className="preview-line"><TerminalSquare size={16} /><RichContent content={texts.previewEnvironment} settings={settings} inline /><Check size={14} /></div>}
    {texts.previewAccount && <div className="preview-line"><CircleDot size={16} /><RichContent content={texts.previewAccount} settings={settings} inline /><Check size={14} /></div>}
    {texts.previewPrompt && <div className="preview-code"><ChevronRight size={16} aria-hidden="true" /><RichContent content={texts.previewPrompt} settings={settings} inline /><i /></div>}
  </div>;
}

function CustomLayout({ settings, children }: { settings: SiteSettings; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const html = contentHtml(settings.login.pageContent, settings, { template: true });
  useLayoutEffect(() => {
    if (!content.current) return;
    let target = content.current.querySelector<HTMLElement>("[data-clinavat-auth-slot]");
    // A malformed HTML template must still leave a working path to sign in.
    if (!target) {
      target = content.current.ownerDocument.createElement("div");
      target.className = "auth-custom-fallback";
      content.current.append(target);
    }
    setSlot(target);
  }, [html]);
  return <main className="auth-custom-page">
    <div ref={content} className="auth-custom-content" dangerouslySetInnerHTML={{ __html: html }} />
    {slot && createPortal(children, slot)}
  </main>;
}

export default function AuthLayout({ settings, children }: { settings: SiteSettings; children: ReactNode }) {
  const { login } = settings;
  const { texts } = login;
  if (login.layout === "custom") return <CustomLayout settings={settings}>{children}</CustomLayout>;
  const centered = login.layout === "centered" || !login.showStory;
  return <main className={`auth-page${centered ? " auth-page-centered" : ""}`}>
    {!centered && <div className="auth-story">
      {login.showBrand && <LoginBrand settings={settings} />}
      <div className="auth-story-body">
        {texts.eyebrow && <div className="eyebrow"><span className="live-dot" /><RichContent content={texts.eyebrow} settings={settings} inline /></div>}
        {settings.welcome && <h1 className="auth-welcome"><RichContent content={settings.welcome} settings={settings} inline /></h1>}
        <RichContent className="auth-description" content={settings.description} settings={settings} />
        <RichContent className="auth-story-content" content={login.storyContent} settings={settings} />
        {login.showPreview && <FeaturePreview settings={settings} />}
      </div>
      {login.footerContent && <div className="auth-footnote"><ShieldCheck size={14} /><RichContent content={login.footerContent} settings={settings} /></div>}
    </div>}
    <div className="auth-form-panel">
      {centered && login.showBrand && <LoginBrand settings={settings} />}
      {centered && login.showStory && <div className="auth-centered-story">
        {settings.welcome && <h1 className="auth-welcome"><RichContent content={settings.welcome} settings={settings} inline /></h1>}
        <RichContent className="auth-description" content={settings.description} settings={settings} />
        <RichContent className="auth-story-content" content={login.storyContent} settings={settings} />
      </div>}
      {centered && login.showPreview && <FeaturePreview settings={settings} />}
      {children}
      {centered && login.footerContent && <RichContent className="auth-centered-footer" content={login.footerContent} settings={settings} />}
    </div>
  </main>;
}
