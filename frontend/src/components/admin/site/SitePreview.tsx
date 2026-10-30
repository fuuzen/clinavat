import { useLayoutEffect, useRef, useState } from "react";
import { Expand, LockKeyhole, Monitor, Palette, Smartphone, X } from "lucide-react";
import Auth from "../../Auth";
import type { SiteSettings } from "../../../site/settings";

export default function SitePreview({ settings, previewUrl }: { settings: SiteSettings; previewUrl: string }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [mode, setMode] = useState<"login" | "register" | "setup">("login");
  const [width, setWidth] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const pageWidth = device === "desktop" ? 1120 : 390;
  const scale = width ? Math.min(1, width / pageWidth) : 1;
  let host = "你的公开域名";
  try { if (previewUrl) host = new URL(previewUrl).host; } catch { /* Invalid URLs are handled in the access editor. */ }
  return <aside className="admin-site-preview-column" aria-label="登录页实时预览">
    <div className="admin-site-preview-heading"><span><span className="admin-site-live-dot" />实时预览</span><button type="button" onClick={() => dialog.current?.showModal()}><Expand size={13} />放大预览</button></div>
    <div className="admin-site-preview-toolbar">
      <div role="group" aria-label="预览设备">{([['desktop', '桌面', Monitor], ['mobile', '手机', Smartphone]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={device === id} onClick={() => setDevice(id)}><Icon size={13} />{label}</button>)}</div>
      <select aria-label="预览表单状态" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="login">登录</option><option value="register">注册</option><option value="setup">首次初始化</option></select>
    </div>
    <div className={`admin-site-preview admin-site-preview-${device}`}>
      <div className="admin-site-browser"><i /><i /><i /><span><LockKeyhole size={10} />{host}</span></div>
      <div className="admin-site-preview-viewport" ref={viewport} style={{ height: 680 * scale }}>
        <div className="admin-site-preview-stage" style={{ width: pageWidth, transform: `scale(${scale})` }}>
          <Auth settings={settings} preview previewMode={mode} needsSetup={mode === "setup"} registrationEnabled onAuthenticated={async () => undefined} />
        </div>
      </div>
    </div>
    <div className="admin-site-preview-note"><Palette size={17} /><div><strong>所见即所得</strong><p>预览可切换表单状态，提交不会创建账号或发送登录请求。修改保留在编辑区，点击「保存并应用」后发布。</p></div></div>
    <dialog ref={dialog} className="admin-site-preview-dialog" onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <header><span>{device === "desktop" ? "桌面" : "手机"}预览 · {settings.name}</span><button type="button" className="icon-button" aria-label="关闭放大预览" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
      <div className="admin-site-preview-expanded" style={{ maxWidth: pageWidth }}><Auth settings={settings} preview previewMode={mode} needsSetup={mode === "setup"} registrationEnabled onAuthenticated={async () => undefined} /></div>
    </dialog>
  </aside>;
}
