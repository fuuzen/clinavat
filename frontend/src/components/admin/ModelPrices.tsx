import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, CircleDollarSign, LoaderCircle, Pencil, RotateCcw, Search, Upload } from "lucide-react";
import { api, errorText } from "../../api";
import type { ModelPrice, ModelPriceList } from "../../types";
import "../../styles/admin-site.css";

const litellmSource = "https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json";
const fields = ["输入", "缓存读取", "缓存写入", "输出"] as const;

interface Draft { model: string; values: string[]; known: boolean }

const shown = (value: number | null) => value === null ? "" : String(value);
const priceText = (price: ModelPrice) => price.map((value) => value === null ? "同输入" : `$${value}`).join(" / ");

/** The prices behind cost estimates: import a newer LiteLLM list, or correct single models. */
export default function ModelPrices() {
  const [list, setList] = useState<ModelPriceList | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<ModelPriceList>("/admin/model-prices", { signal: controller.signal }).then(setList)
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, []);
  const entries = useMemo(() => (list?.entries ?? []).filter((entry) => entry.model.includes(search.trim().toLowerCase())), [list, search]);
  async function change(path: string, init: RequestInit, done: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setList(await api<ModelPriceList>(path, init));
      setMessage(done);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function importFile(file: File) {
    if (fileRef.current) fileRef.current.value = "";
    let document: Record<string, { litellm_provider?: unknown }>;
    try { document = JSON.parse(await file.text()); }
    catch { setError("文件不是有效的 JSON"); return; }
    // LiteLLM's full list is several megabytes; only these providers' entries are sent, the Hub filters them exactly.
    const subset = Object.fromEntries(Object.entries(document ?? {})
      .filter(([, model]) => model && ["openai", "anthropic", "gemini"].includes(String(model.litellm_provider))));
    await change("/admin/model-prices/snapshot", { method: "PUT", body: JSON.stringify(subset) }, `已导入「${file.name}」，用量统计按新价格重新折算`);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const [input, cacheRead, cacheWrite, output] = draft.values.map((value) => value.trim() === "" ? null : Number(value));
    if (input === null || output === null || [input, cacheRead, cacheWrite, output].some((value) => value !== null && !Number.isFinite(value))) {
      setError("请填写有效的输入和输出价格；缓存价格留空表示按输入价格计算");
      return;
    }
    const saved = await change("/admin/model-prices/overrides", { method: "PUT", body: JSON.stringify({ model: draft.model, input, cacheRead, cacheWrite, output }) },
      `已保存「${draft.model}」的自定义价格`);
    if (saved) setDraft(null);
  }
  const edit = (model: string, price?: ModelPrice) => setDraft({ model, values: price ? price.map(shown) : ["", "", "", ""], known: !!price });
  return (
    <section className="admin-card model-prices" aria-busy={!list || busy}>
      <div className="admin-card-heading">
        <div><CircleDollarSign size={17} /><h3>模型价格</h3></div>
        <div className="model-prices-actions">
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
          <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={13} />导入 LiteLLM 价格文件
          </button>
          {list?.snapshot.source === "imported" && (
            <button type="button" className="button button-secondary button-small" disabled={busy}
              onClick={() => void change("/admin/model-prices/snapshot", { method: "DELETE" }, "已恢复为内置价格快照")}>
              <RotateCcw size={13} />恢复内置快照
            </button>
          )}
        </div>
      </div>
      <p className="token-usage-note">
        {list ? `当前使用${list.snapshot.source === "imported" ? ` ${list.snapshot.date} 导入的` : `内置的 ${list.snapshot.date} `}价格快照，共 ${list.snapshot.models} 个模型。` : "正在读取价格…"}
        单位为美元 / 百万 Token。导入时上传 LiteLLM 的 <a href={litellmSource} target="_blank" rel="noreferrer">model_prices_and_context_window.json</a>，
        只保留其中 OpenAI、Anthropic 和 Google Gemini 的模型。自定义价格优先于快照，也会替代 Claude CLI 自己估算的金额；价格变更会应用到所有已记录的用量。
      </p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {message && <p className="admin-site-access-status" role="status"><Check size={13} />{message}</p>}
      {!!list?.unpricedModels.length && (
        <div className="model-prices-missing">
          <span>以下模型有用量但没有价格：</span>
          {list.unpricedModels.map((model) => (
            <button key={model} type="button" className="text-button" onClick={() => edit(model)}>{model}</button>
          ))}
        </div>
      )}
      {draft && (
        <form className="model-price-form" onSubmit={(event) => void save(event)}>
          <label>模型<input value={draft.model} readOnly={draft.known} onChange={(event) => setDraft({ ...draft, model: event.target.value })} required /></label>
          {fields.map((label, index) => (
            <label key={label}>{label}
              <input inputMode="decimal" value={draft.values[index]} placeholder={index === 1 || index === 2 ? "同输入" : undefined}
                required={index === 0 || index === 3}
                onChange={(event) => setDraft({ ...draft, values: draft.values.map((value, position) => position === index ? event.target.value : value) })} />
            </label>
          ))}
          <div className="model-price-form-actions">
            <button type="submit" className="button button-primary button-small" disabled={busy}>
              {busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}保存
            </button>
            <button type="button" className="button button-secondary button-small" onClick={() => setDraft(null)}>取消</button>
          </div>
        </form>
      )}
      <div className="model-prices-toolbar">
        <label className="model-prices-search"><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" /></label>
        <button type="button" className="button button-secondary button-small" onClick={() => edit("")}>添加自定义价格</button>
      </div>
      <div className="token-usage-scroll">
        <table className="token-usage-table">
          <thead><tr><th>模型</th><th>输入 / 缓存读取 / 缓存写入 / 输出</th><th>来源</th><th /></tr></thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.model}>
                <td>{entry.model}</td>
                <td title={entry.custom && entry.snapshot ? `快照价格：${priceText(entry.snapshot)}` : undefined}>{priceText(entry.price)}</td>
                <td>{entry.custom ? <span className="badge badge-amber">自定义</span> : "快照"}</td>
                <td className="model-price-row-actions">
                  <button type="button" className="icon-button" aria-label={`编辑 ${entry.model} 的价格`} title="编辑价格" onClick={() => edit(entry.model, entry.price)}>
                    <Pencil size={13} />
                  </button>
                  {entry.custom && (
                    <button type="button" className="icon-button" disabled={busy} aria-label={`撤销 ${entry.model} 的自定义价格`} title={entry.snapshot ? "恢复快照价格" : "删除自定义价格"}
                      onClick={() => void change(`/admin/model-prices/overrides?model=${encodeURIComponent(entry.model)}`, { method: "DELETE" }, `已撤销「${entry.model}」的自定义价格`)}>
                      <RotateCcw size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
