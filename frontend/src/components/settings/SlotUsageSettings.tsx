import { useEffect, useState } from "react";
import { Check, LoaderCircle, Save } from "lucide-react";
import { api, errorText } from "../../api";
import type { UsageSettings } from "../../types";

const HOUR = 3_600_000;
const hours = (milliseconds: number) => String(Math.round((milliseconds / HOUR) * 100) / 100);

/** How often idle slots' quota is queried and how long a reading stays current, for every slot. */
export default function SlotUsageSettings() {
  const [saved, setSaved] = useState<UsageSettings | null>(null);
  const [refreshHours, setRefreshHours] = useState("");
  const [staleHours, setStaleHours] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function show(value: UsageSettings) {
    setSaved(value);
    setRefreshHours(hours(value.refreshIntervalMs));
    setStaleHours(hours(value.staleAfterMs));
  }
  useEffect(() => {
    const controller = new AbortController();
    api<UsageSettings>("/admin/settings/usage", { signal: controller.signal })
      .then(show)
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, []);
  const draft: UsageSettings = {
    refreshIntervalMs: Math.round(Number(refreshHours) * HOUR),
    staleAfterMs: Math.round(Number(staleHours) * HOUR),
  };
  const dirty = !!saved && (draft.refreshIntervalMs !== saved.refreshIntervalMs || draft.staleAfterMs !== saved.staleAfterMs);
  return (
    <form className="slot-usage-settings" aria-busy={!saved || saving} onSubmit={(event) => {
      event.preventDefault();
      setSaving(true); setError(""); setMessage("");
      api<UsageSettings>("/admin/settings/usage", { method: "PUT", body: JSON.stringify(draft) })
        .then((value) => { show(value); setMessage("已保存，对所有槽位生效。"); })
        .catch((cause) => setError(errorText(cause)))
        .finally(() => setSaving(false));
    }}>
      <label>
        额度刷新周期
        <span><input type="number" min={0.25} max={168} step={0.25} required value={refreshHours} disabled={!saved || saving}
          onChange={(event) => { setRefreshHours(event.target.value); setMessage(""); }} />小时</span>
      </label>
      <label>
        额度有效期
        <span><input type="number" min={0.25} max={168} step={0.25} required value={staleHours} disabled={!saved || saving}
          onChange={(event) => { setStaleHours(event.target.value); setMessage(""); }} />小时</span>
      </label>
      <button type="submit" className="button button-secondary button-small" disabled={saving || !dirty}>
        {saving ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}保存
      </button>
      <small>
        空闲槽位每隔一个刷新周期查询一次额度，超过有效期的额度显示为过期。运行中的对话由 CLI 原生推送额度，随时更新，不受周期限制。
      </small>
      {error && <small className="inline-error" role="alert">{error}</small>}
      {message && <small className="slot-usage-settings-saved" role="status"><Check size={12} />{message}</small>}
    </form>
  );
}
