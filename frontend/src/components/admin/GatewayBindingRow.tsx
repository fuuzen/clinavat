import { useEffect, useRef, useState } from "react";
import { Globe2, LoaderCircle, Save } from "lucide-react";
import { api, errorText } from "../../api";
import TimezonePicker, { validTimezone, type TimezoneOptions } from "./TimezonePicker";

export interface GatewaySource {
  address: string; kind: "host" | "builder" | "slot" | "workspace"; label: string;
  slotId?: string; timezone?: string | null; defaultTimezone?: string;
}
interface NodeLocation {
  node: string; ip: string; country: string | null; region: string | null; city: string | null; timezone: string;
}

export default function GatewayBindingRow({ source, binding, nodes, timezones, disabled, bound, onSave }: {
  source: GatewaySource; binding?: { node: string }; nodes: { tag: string }[]; timezones: TimezoneOptions;
  disabled: boolean; bound: boolean;
  onSave: (node: string | null, interrupt: boolean, timezone?: string | null) => void;
}) {
  const current = binding?.node ?? "";
  const currentTimezone = source.timezone ?? "";
  const supportsTimezone = source.kind === "slot" && !!source.slotId;
  const [draft, setDraft] = useState(current);
  const [manualTimezone, setManualTimezone] = useState<string>();
  const [recommendedTimezone, setRecommendedTimezone] = useState<string>();
  const timezone = recommendedTimezone ?? manualTimezone ?? currentTimezone;
  const [interrupt, setInterrupt] = useState(false);
  const [location, setLocation] = useState<NodeLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const request = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const timezoneEdits = useRef(0);

  function cancelLocation() {
    request.current.controller?.abort();
    request.current = { id: request.current.id + 1 };
  }

  useEffect(() => {
    cancelLocation();
    setDraft(current);
    setManualTimezone(undefined);
    setRecommendedTimezone(undefined);
    setInterrupt(false);
    setLocation(null);
    setLocationError("");
    setLocating(false);
    timezoneEdits.current++;
    return cancelLocation;
  }, [current, currentTimezone, source.slotId]);

  useEffect(() => {
    if (disabled) { cancelLocation(); setLocating(false); }
  }, [disabled]);

  async function recommend(node: string, useRecommendation = false) {
    cancelLocation();
    if (!node || !supportsTimezone) { setLocating(false); return; }
    const id = request.current.id;
    const controller = new AbortController();
    request.current.controller = controller;
    const editVersion = timezoneEdits.current;
    setLocating(true);
    setLocation(null);
    setLocationError("");
    try {
      const found = await api<NodeLocation>(`/admin/gateway/nodes/${encodeURIComponent(node)}/location`, {
        method: "POST", body: "{}", signal: controller.signal,
      });
      if (request.current.id !== id) return;
      if (!found.timezone || !validTimezone(found.timezone)) throw new Error("出口位置未返回有效时区，请手动选择。");
      setLocation(found);
      // Automatic lookup must preserve a manual choice, including one made while the lookup runs.
      if (timezoneEdits.current === editVersion && (useRecommendation || manualTimezone === undefined)) {
        setRecommendedTimezone(found.timezone);
      }
    } catch (cause) {
      if (request.current.id === id && !controller.signal.aborted) setLocationError(errorText(cause));
    } finally {
      if (request.current.id === id) setLocating(false);
    }
  }

  function changeNode(node: string) {
    setDraft(node);
    setRecommendedTimezone(undefined);
    setLocation(null);
    setLocationError("");
    if (node === current) {
      setInterrupt(false);
      cancelLocation();
      setLocating(false);
    } else {
      void recommend(node);
    }
  }

  function changeTimezone(value: string) {
    timezoneEdits.current++;
    setManualTimezone(value);
    setRecommendedTimezone(undefined);
  }

  function save() {
    cancelLocation();
    setLocating(false);
    onSave(draft || null, draft !== current && interrupt, supportsTimezone ? timezone || null : undefined);
  }

  const changed = draft !== current || (supportsTimezone && timezone !== currentTimezone);
  const locationName = location ? [...new Set([location.country, location.region, location.city].filter(Boolean))].join(" / ") : "";
  return (
    <div className="gateway-row gateway-binding">
      <div className="gateway-binding-identity"><strong>{source.label}</strong><small><code>{source.address}</code></small></div>
      <div className="gateway-binding-controls">
        <label className="gateway-binding-node">出口节点
          <select value={draft} disabled={disabled} onChange={(event) => changeNode(event.target.value)} aria-label={`${source.label}的出口节点`}>
            <option value="">未绑定{bound ? "（断网）" : ""}</option>
            {nodes.map((node) => <option key={node.tag} value={node.tag}>{node.tag}</option>)}
          </select>
        </label>
        <label className="gateway-force" title="切换后已有连接默认继续使用原节点，直到它们自然结束">
          <input type="checkbox" checked={interrupt} disabled={disabled || draft === current} onChange={(event) => setInterrupt(event.target.checked)} />
          中断已有连接
        </label>
        <button type="button" className="button button-primary button-small" disabled={disabled || !changed || (supportsTimezone && !validTimezone(timezone))}
          onClick={save}><Save size={14} />应用</button>
        {supportsTimezone && <div className="gateway-timezone">
          <TimezonePicker value={timezone} current={currentTimezone} defaultTimezone={source.defaultTimezone || timezones.defaultTimezone}
            options={timezones.timezones} disabled={disabled} onChange={changeTimezone} />
          <button type="button" className="button button-secondary button-small" disabled={disabled || !draft || locating}
            onClick={() => void recommend(draft, true)}>
            {locating ? <LoaderCircle size={13} className="spin" /> : <Globe2 size={13} />}按出口 IP 推荐
          </button>
          {locating && <p className="gateway-hint gateway-timezone-result" role="status">正在查询所选节点的出口位置，可继续手动选择时区。</p>}
          {location && <p className="gateway-hint gateway-timezone-result" role="status">
            出口 <code>{location.ip}</code>{locationName ? ` · ${locationName}` : ""} · 推荐 <strong>{location.timezone}</strong>
            {timezone === location.timezone ? currentTimezone === timezone ? "（已应用）" : "（已选中，应用后生效）" : <button type="button" className="button button-ghost button-small"
              disabled={disabled} onClick={() => changeTimezone(location.timezone)}>采用推荐时区</button>}
          </p>}
          {locationError && <p className="gateway-field-error gateway-timezone-result" role="alert">自动推荐失败：{locationError} 可手动选择时区或重试。</p>}
          <p className="gateway-hint gateway-timezone-result">时区变更需槽位空闲；保存后用于登录及后续运行。</p>
        </div>}
      </div>
    </div>
  );
}
