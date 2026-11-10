import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { newHubId, type Hub } from "./hubs";
import { errorMessage, normalizeHubUrl } from "./native";

interface Props {
  hub: Hub | null;
  hubs: Hub[];
  onSave: (hub: Hub) => void;
  /** Absent while the list is empty, since there is nothing to return to. */
  onCancel?: () => void;
}

export default function HubForm({ hub, hubs, onSave, onCancel }: Props) {
  const [url, setUrl] = useState(hub?.url ?? "");
  const [name, setName] = useState(hub?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const normalized = await normalizeHubUrl(url);
      if (hubs.some((item) => item.url === normalized && item.id !== hub?.id)) throw new Error("列表中已有这个地址");
      onSave({ id: hub?.id ?? newHubId(), name: name.trim() || new URL(normalized).host, url: normalized });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <form className="hub-form" onSubmit={(event) => void submit(event)}>
      <label>
        地址
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://hub.example.com"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="url"
          spellCheck={false}
          required
          autoFocus
          disabled={busy}
        />
      </label>
      <label>
        名称
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="可选，默认使用主机名"
          maxLength={60}
          disabled={busy}
        />
      </label>
      <p className="hub-hint">
        填写在浏览器中访问 Hub 的地址，省略协议时按 HTTPS 处理；HTTP 只能用于本机或内网地址。这个地址需要已加入 Hub 的公开访问地址。
      </p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="hub-form-actions">
        {onCancel && (
          <button type="button" className="button button-ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
        )}
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy && <LoaderCircle size={16} className="spin" />}
          保存
        </button>
      </div>
    </form>
  );
}
