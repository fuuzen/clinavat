import { useEffect, useRef, useState } from "react";
import { Check, Globe2, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { api, ApiError, errorText } from "../../api";
import SitePublicUrls, { maxPublicUrls, normalizePublicUrls, validatePublicUrl } from "./SitePublicUrls";
import "../../styles/admin-site.css";

interface SiteAccessConfig {
  publicUrls: string[];
  localOrigins: string[];
  revision: number;
}

function sameUrls(left: string[], right: string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readConfig(options?: RequestInit): Promise<SiteAccessConfig> {
  const value = await api<SiteAccessConfig>("/admin/site-access", options);
  if (!value || !Array.isArray(value.publicUrls) || value.publicUrls.some((address) => typeof address !== "string" || validatePublicUrl(address))
    || !Array.isArray(value.localOrigins) || value.localOrigins.some((address) => typeof address !== "string")
    || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("服务器返回的访问配置无效，请重新读取。");
  return { ...value, publicUrls: normalizePublicUrls(value.publicUrls) };
}

export default function SiteAccessSettings({ onConfigLoaded }: { onConfigLoaded?: (publicUrls: string[]) => void }) {
  const [config, setConfig] = useState<SiteAccessConfig | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [showServerUrls, setShowServerUrls] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const invalid = addresses.some((address) => !!validatePublicUrl(address)) || addresses.length > maxPublicUrls;
  const normalized = invalid ? null : normalizePublicUrls(addresses);
  const dirty = !config || !normalized || !sameUrls(normalized, config.publicUrls);
  const busy = loading || saving;

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => { mountedRef.current = false; };
  }, []);

  async function reload() {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const latest = await readConfig();
      if (!mountedRef.current) return;
      onConfigLoaded?.(latest.publicUrls);
      setConfig(latest);
      setNeedsReload(false);
      if (!config || (!dirty && !needsReload)) {
        setAddresses(latest.publicUrls);
        setShowServerUrls(false);
      } else if (normalized && sameUrls(normalized, latest.publicUrls)) {
        setAddresses(latest.publicUrls);
        setShowServerUrls(false);
        setMessage("已确认服务器正在使用这份访问配置。");
      } else {
        setShowServerUrls(true);
        setMessage("已读取服务器最新配置，你的输入已保留，确认后可重新保存。");
      }
    } catch (cause) {
      if (mountedRef.current) {
        setNeedsReload(true);
        setError(`读取访问配置失败：${errorText(cause)}。请重新读取后再保存。`);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }

  async function save() {
    if (busyRef.current || busy || !config || !normalized || !dirty || needsReload) return;
    busyRef.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await readConfig({ method: "PATCH", body: JSON.stringify({ publicUrls: normalized, expectedRevision: config.revision }) });
      if (!mountedRef.current) return;
      onConfigLoaded?.(saved.publicUrls);
      setConfig(saved);
      setAddresses(saved.publicUrls);
      setNeedsReload(false);
      setShowServerUrls(false);
      setMessage("访问配置已保存，已立即应用到全站。");
    } catch (cause) {
      if (!mountedRef.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const latest = await readConfig();
          if (!mountedRef.current) return;
          onConfigLoaded?.(latest.publicUrls);
          setConfig(latest);
          setNeedsReload(false);
          if (sameUrls(normalized, latest.publicUrls)) {
            setAddresses(latest.publicUrls);
            setShowServerUrls(false);
            setMessage("已确认服务器正在使用这份访问配置。");
          } else {
            setShowServerUrls(true);
            setError("访问配置已被更新，已读取最新版本。你的输入已保留，请核对后重新保存。");
          }
        } catch (refreshError) {
          if (mountedRef.current) {
            setNeedsReload(true);
            setError(`访问配置已被更新，但最新版本读取失败：${errorText(refreshError)}。你的输入已保留，请重新读取后再保存。`);
          }
        }
      } else {
        setNeedsReload(true);
        setError(`未能确认保存结果：${errorText(cause)}。你的输入已保留，请重新读取服务器配置确认后再试。`);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="admin-card admin-site-section admin-site-access" aria-busy={busy}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
      <div className="admin-card-heading"><h3>访问配置</h3><button type="button" className="icon-button" disabled={busy}
        aria-label="重新读取访问配置" title="重新读取访问配置" onClick={() => void reload()}><RefreshCw size={15} className={loading ? "spin" : ""} /></button></div>
      <p className="admin-site-description">配置全站允许访问的公开地址，保存后立即生效。下方可管理网关反向代理与证书；品牌、登录页和外观在「站点个性化」中设置。</p>
      <SitePublicUrls value={addresses} disabled={busy || !config} onChange={(next) => {
        if (busyRef.current) return;
        setAddresses(next);
        setMessage("");
      }} />
      {addresses.length > maxPublicUrls && <p className="admin-site-field-error" role="alert">公开域名不能超过 {maxPublicUrls} 个，请移除多余地址。</p>}
      {config && <div className="admin-site-local-origins" role="group" aria-label="本机访问地址"><span><Globe2 size={13} />本机访问地址自动保留</span>
        <div>{config.localOrigins.map((origin) => <code key={origin}>{origin}</code>)}</div></div>}
      {showServerUrls && config && <div className="admin-site-server-urls"><span>服务器当前公开域名</span><div>{config.publicUrls.length ? config.publicUrls.map((address) => <code key={address}>{address}</code>) : <small>未配置公开域名</small>}</div></div>}
      {error && <p className="admin-site-access-error" role="alert">{error}</p>}
      {message && <p className="admin-site-access-status" role="status"><Check size={13} />{message}</p>}
      <div className="admin-site-access-actions"><span>{loading ? "正在读取服务器配置…" : dirty && config ? "有未保存的访问配置" : config ? "与服务器配置一致" : "尚未读取服务器配置"}</span>
        <button type="button" className="button button-primary button-small" disabled={busy || !config || invalid || !dirty || needsReload} onClick={() => void save()}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{saving ? "正在保存…" : "保存访问配置"}
        </button></div>
    </section>
  );
}
