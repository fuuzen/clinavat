import { useId } from "react";
import { Globe2, Plus, X } from "lucide-react";

export function validatePublicUrl(value: string): string {
  const address = value.trim();
  if (!address) return "";
  try {
    if (address.length > 2048 || !/^https?:\/\/[^/?#\\@\s*]+\/?$/i.test(address)) throw new Error("invalid");
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || decodeURIComponent(url.hostname).includes("*") || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") throw new Error("invalid");
    return "";
  } catch {
    return "请输入完整的 http:// 或 https:// 地址，不包含通配符、路径、参数或账号信息。";
  }
}

export function normalizePublicUrls(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => new URL(value.trim()).origin))];
}

export const maxPublicUrls = 100;

export default function SitePublicUrls({ value, onChange, disabled = false }: { value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const id = useId();
  const rows = value.length ? value : [""];
  return (
    <div className="admin-site-urls" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="admin-site-urls-label">Public URL <span className="admin-site-label-note">公开域名</span></span>
      <div className="admin-site-url-list">
        {rows.map((address, index) => {
          const error = validatePublicUrl(address);
          return (
            <div className="admin-site-url-item" key={index}>
              <div className="admin-site-url-row">
                <div className="admin-site-url-input"><Globe2 size={15} aria-hidden="true" />
                  <input value={address} type="url" maxLength={2048} placeholder="https://workspace.example.com"
                    disabled={disabled}
                    aria-label={`公开域名 ${index + 1}`} aria-invalid={!!error}
                    aria-describedby={error ? `${id}-error-${index}` : `${id}-note`}
                    onChange={(event) => onChange(rows.map((entry, row) => row === index ? event.target.value : entry))} />
                </div>
                <button type="button" className="icon-button admin-site-url-remove" aria-label={`移除公开域名 ${index + 1}`} title="移除此域名"
                  disabled={disabled || (rows.length === 1 && !address)} onClick={() => onChange(rows.filter((_, row) => row !== index))}><X size={15} /></button>
              </div>
              {error && <p id={`${id}-error-${index}`} className="admin-site-field-error" role="alert">{error}</p>}
            </div>
          );
        })}
      </div>
      <button type="button" className="button button-secondary button-small admin-site-url-add" disabled={disabled || rows.length >= maxPublicUrls} onClick={() => onChange([...rows, ""])}><Plus size={13} />添加域名</button>
      <p id={`${id}-note`} className="admin-site-hint">最多 {maxPublicUrls} 个访问地址，保存时自动规范化并去重；域名解析和 HTTPS 需单独配置。</p>
    </div>
  );
}
