import { useEffect, useRef, useState } from "react";
import { Check, Globe2, ImagePlus, Palette, Upload, X } from "lucide-react";
import { themePresets } from "../../../theme";
import type { SiteSettings } from "../../../site/settings";

interface Props {
  value: SiteSettings;
  onChange: (next: SiteSettings) => void;
  onUploadBusy: (busy: boolean) => void;
  onError: (error: string) => void;
}

export default function BrandSettings({ value, onChange, onUploadBusy, onError }: Props) {
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => () => { revision.current++; }, []);

  function update<K extends keyof SiteSettings>(key: K, next: SiteSettings[K]) {
    onChange({ ...latest.current, [key]: next });
  }
  function setBusy(next: boolean) { setUploading(next); onUploadBusy(next); }
  function upload(file?: File) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      onError("请选择不超过 2 MB 的 PNG、JPEG 或 WebP 图片。");
      return;
    }
    const current = ++revision.current;
    setBusy(true);
    onError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (current !== revision.current) return;
      const source = String(reader.result);
      const image = new Image();
      image.onload = () => {
        if (current !== revision.current) return;
        update("logo", source);
        setBusy(false);
      };
      image.onerror = () => {
        if (current !== revision.current) return;
        onError("无法打开这张图片，请重新选择。");
        setBusy(false);
      };
      image.src = source;
    };
    reader.onerror = () => {
      if (current !== revision.current) return;
      onError("图片读取失败，请重新选择。");
      setBusy(false);
    };
    reader.readAsDataURL(file);
  }

  return <>
    <section className="admin-card admin-site-section">
      <div className="admin-card-heading"><h3>站点信息</h3><Globe2 size={19} /></div>
      <p className="admin-site-description">保存后应用到登录页、工作台品牌与浏览器标题。欢迎标语和说明支持下方选择的 Markdown / HTML 格式。</p>
      <label>站点名称<input aria-label="站点名称" value={value.name} maxLength={80} required onChange={(event) => update("name", event.target.value)} /></label>
      <label>欢迎标语<textarea aria-label="欢迎标语" rows={2} value={value.welcome} maxLength={4000} onChange={(event) => update("welcome", event.target.value)} /></label>
      <label>站点说明<textarea aria-label="站点说明" rows={3} value={value.description} maxLength={65536} onChange={(event) => update("description", event.target.value)} /></label>
    </section>
    <section className="admin-card admin-site-section">
      <div className="admin-card-heading"><h3>品牌标识</h3><ImagePlus size={19} /></div>
      <div className="admin-site-logo-upload">
        <span className="admin-site-logo-sample"><img src={value.logo || "/clinavat.svg"} alt="站点 Logo 预览" /></span>
        <div><strong>站点 Logo</strong><p>推荐方形透明底图片，最大 2 MB</p><div className="admin-site-logo-actions">
          <button type="button" className="button button-secondary button-small" disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={13} />{uploading ? "读取中…" : "上传图片"}</button>
          {value.logo && <button type="button" className="text-button" onClick={() => { revision.current++; setBusy(false); update("logo", ""); }}><X size={13} />使用默认</button>}
        </div></div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="上传站点 Logo" onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
      <label>Logo 地址<input aria-label="Logo 地址" value={value.logo.startsWith("data:") ? "" : value.logo} disabled={uploading} placeholder={value.logo.startsWith("data:") ? "已上传图片；输入地址可替换" : "站内绝对路径，如 /images/logo.png"} onChange={(event) => update("logo", event.target.value)} /></label>
      <label>浏览器图标地址<input aria-label="浏览器图标地址" value={value.favicon} placeholder="留空使用默认图标；支持站内路径或图片 data URL" onChange={(event) => update("favicon", event.target.value)} /></label>
      <p className="admin-site-hint">图片使用站内资源或上传的图片，不支持外部图片地址。</p>
    </section>
    <section className="admin-card admin-site-section">
      <div className="admin-card-heading"><h3>默认配色方案</h3><Palette size={19} /></div>
      <p className="admin-site-description">登录页使用此配色；工作台中未设置个人外观的成员也会使用此默认配色。</p>
      <div className="admin-site-themes" role="group" aria-label="站点默认配色">
        {themePresets.map((preset) => <button key={preset.id} type="button" className={`admin-site-theme ${value.theme === preset.id ? "selected" : ""}`} aria-pressed={value.theme === preset.id} onClick={() => update("theme", preset.id)}>
          <span className="admin-site-theme-swatch" style={{ background: preset.background, color: preset.accent }}><i /><span><b /><b /><b /></span></span>
          <span className="admin-site-theme-label">{preset.name}<small>{preset.mode === "dark" ? "深色" : "浅色"}</small>{value.theme === preset.id && <Check size={13} />}</span>
        </button>)}
      </div>
    </section>
  </>;
}
