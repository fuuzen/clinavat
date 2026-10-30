import { useSiteSettings } from "../site/store";

export function BrandMark({ size = 40 }: { size?: number }) {
  const settings = useSiteSettings();
  return <img className="brand-logo" src={settings.logo || `${import.meta.env.BASE_URL}clinavat.svg`} width={size} height={size} alt="" aria-hidden="true" style={{ objectFit: "contain" }} />;
}

export default function Brand({ compact = false }: { compact?: boolean }) {
  const settings = useSiteSettings();
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark"><BrandMark /></span>
      <span className="brand-wordmark" title={settings.name}>{settings.name}</span>
    </div>
  );
}
