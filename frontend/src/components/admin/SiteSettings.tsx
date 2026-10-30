import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Download, LoaderCircle, RefreshCw, RotateCcw, Save, Upload } from "lucide-react";
import { api, errorText } from "../../api";
import { defaultSiteSettings, type SiteSettings as SiteConfig } from "../../site/settings";
import { publishSiteSettings } from "../../site/store";
import BrandSettings from "./site/BrandSettings";
import LoginDesignSettings from "./site/LoginDesignSettings";
import LoginTextSettings from "./site/LoginTextSettings";
import SitePreview from "./site/SitePreview";
import { parseDesignFile, downloadDesign, validateDesign } from "./site/design-transfer";
import "../../styles/admin-site.css";

export default function SiteSettings({ userId }: { userId: string }) {
  return <SiteSettingsForm key={userId} />;
}

function SiteSettingsForm() {
  const [draft, setDraft] = useState<SiteConfig>(defaultSiteSettings);
  const [saved, setSaved] = useState<SiteConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const busy = saving || reading || uploading;
  const dirty = saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<SiteConfig>("/admin/site/settings", { signal: controller.signal }).then((latest) => {
      if (controller.signal.aborted) return;
      const config = validateDesign(latest);
      setDraft(config);
      setSaved(config);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(`读取个性化配置失败：${errorText(cause)}`);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [loadVersion]);

  function change(next: SiteConfig) {
    setDraft(next);
    setMessage("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || busy || loading || inFlight.current) return;
    let next: SiteConfig;
    try { next = validateDesign({ ...draft, name: draft.name.trim() }); }
    catch (cause) { setError(errorText(cause)); return; }
    inFlight.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = validateDesign(await api<SiteConfig>("/admin/site/settings", { method: "PUT", body: JSON.stringify(next) }));
      publishSiteSettings(result);
      if (!mounted.current) return;
      setDraft(result);
      setSaved(result);
      setMessage("个性化配置已保存并应用到全站。新访问的登录页将使用当前设计。");
    } catch (cause) {
      if (mounted.current) setError(`保存失败：${errorText(cause)}。当前修改已保留。`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function importDesign(file?: File) {
    if (!file || busy) return;
    setReading(true);
    setError("");
    try {
      const next = await parseDesignFile(file);
      if (!mounted.current) return;
      change(next);
      setMessage("设计已导入预览，点击「保存并应用」后生效。");
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  return <div className="admin-site-layout">
    <div className="admin-site-fields">
      {loading ? <section className="admin-card admin-site-section admin-site-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取个性化配置…</section> : !saved ? <section className="admin-card admin-site-section">
        <div className="inline-error" role="alert">{error}</div>
        <button type="button" className="button button-secondary button-small" onClick={() => setLoadVersion((value) => value + 1)}><RefreshCw size={14} />重新读取</button>
      </section> : <form className="admin-site-form" onSubmit={(event) => void save(event)}>
        <fieldset className="admin-site-fieldset" disabled={saving || reading}>
          <BrandSettings value={draft} onChange={change} onUploadBusy={setUploading} onError={setError} />
          <LoginDesignSettings value={draft} onChange={change} />
          <LoginTextSettings value={draft} onChange={change} />
          <section className="admin-card admin-site-section">
            <div className="admin-card-heading"><h3>设计备份</h3><Download size={18} /></div>
            <p className="admin-site-description">导入、恢复默认仅更新预览；保存后才会发布。导出的 JSON 包含公开页面内容与图片，不含账号或访问配置。</p>
            <div className="admin-site-transfer-actions">
              <button type="button" className="button button-secondary button-small" onClick={() => downloadDesign(draft)}><Download size={13} />导出 JSON</button>
              <button type="button" className="button button-secondary button-small" disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={13} />导入 JSON</button>
              <button type="button" className="text-button" disabled={uploading} onClick={() => change(structuredClone(defaultSiteSettings))}><RotateCcw size={13} />恢复默认设计</button>
              <input ref={fileInput} type="file" accept="application/json,.json" hidden aria-label="导入站点设计 JSON" onChange={(event) => { void importDesign(event.target.files?.[0]); event.target.value = ""; }} />
            </div>
          </section>
        </fieldset>
        <div className="admin-site-savebar">
          <span className={dirty ? "admin-site-unsaved" : "admin-muted"}>{dirty ? "有尚未应用的修改" : "与全站配置一致"}</span>
          <button type="button" className="button button-secondary button-small" disabled={!dirty || busy} onClick={() => { setDraft(saved); setError(""); setMessage(""); }}><RotateCcw size={13} />撤销修改</button>
          <button type="submit" className="button button-primary button-small" disabled={!dirty || busy}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{saving ? "正在保存…" : "保存并应用"}</button>
        </div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {message && <p className="admin-site-saved" role="status"><Check size={14} />{message}</p>}
      </form>}
    </div>
    {saved && <SitePreview settings={draft} previewUrl={window.location.origin} />}
  </div>;
}
