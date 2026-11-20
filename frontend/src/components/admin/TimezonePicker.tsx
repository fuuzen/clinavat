import { useId, useMemo } from "react";
import { RotateCcw } from "lucide-react";

export interface TimezoneOptions { timezones: string[]; defaultTimezone: string }
const timezoneLabels = new Map<string, string>();

export function validTimezone(value: string): boolean {
  if (!value) return true;
  if (value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }); return true; }
  catch { return false; }
}

export function browserTimezones(): string[] {
  try { return Intl.supportedValuesOf("timeZone"); }
  catch { return ["UTC"]; }
}

function timezoneLabel(timezone: string, date: Date): string {
  const key = `${date.toISOString().slice(0, 10)}:${timezone}`;
  const saved = timezoneLabels.get(key);
  if (saved) return saved;
  try {
    const name = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, timeZoneName: "longGeneric" })
      .formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
    const offset = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "shortOffset" })
      .formatToParts(date).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "UTC");
    const label = [offset, name].filter(Boolean).join(" · ");
    timezoneLabels.set(key, label);
    return label;
  } catch { return timezone; }
}

export default function TimezonePicker({ value, current, defaultTimezone, options, disabled, onChange }: {
  value: string; current: string; defaultTimezone: string; options: string[]; disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const entries = useMemo(() => {
    const date = new Date();
    return [...new Set(["UTC", ...options, current].filter(Boolean))].sort()
      .map((timezone) => ({ timezone, label: timezoneLabel(timezone, date) }));
  }, [options, current]);
  const valid = validTimezone(value);
  const following = `跟随默认${defaultTimezone ? `（${defaultTimezone}）` : ""}`;
  return (
    <div className="gateway-timezone-picker">
      <label htmlFor={id}>VM 时区{value !== current ? "（待应用）" : ""}</label>
      <div className="gateway-timezone-input">
        <input id={id} list={`${id}-options`} value={value} autoComplete="off" spellCheck={false}
          disabled={disabled} placeholder={following} aria-invalid={!valid} aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.value.trim())} />
        <datalist id={`${id}-options`}>
          {entries.map(({ timezone, label }) => <option key={timezone} value={timezone}>{label}</option>)}
        </datalist>
        <button type="button" className="button button-ghost button-small" disabled={disabled || !value}
          title={following} onClick={() => onChange("")}><RotateCcw size={12} />默认</button>
      </div>
      <p className={valid ? "gateway-hint" : "gateway-field-error"} id={`${id}-hint`}>
        {valid ? `当前：${current || following}；可搜索 IANA 时区、城市英文名或 UTC 偏移。` : "请选择有效的 IANA 时区，例如 Asia/Shanghai。"}
      </p>
    </div>
  );
}
