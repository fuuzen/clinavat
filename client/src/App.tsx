import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import logo from "../../frontend/public/clinavat.svg";
import HubForm from "./HubForm";
import HubList from "./HubList";
import { claimLaunch, loadBook, saveBook, type Hub, type HubBook } from "./hubs";
import { closeHub, errorMessage, openHub } from "./native";

type Screen = { kind: "list" } | { kind: "form"; hub: Hub | null } | { kind: "opening"; hub: Hub };

// On Apple platforms a failed navigation leaves this page in place, so a stalled attempt is reported here.
const slowOpenMs = 15_000;

export default function App() {
  const [book, setBook] = useState(loadBook);
  const [screen, setScreen] = useState<Screen>(() => (book.hubs.length ? { kind: "list" } : { kind: "form", hub: null }));
  const [error, setError] = useState("");
  const [slow, setSlow] = useState(false);

  function update(next: HubBook) {
    setBook(next);
    try {
      saveBook(next);
    } catch {
      setError("无法保存 Hub 列表，修改只在本次运行中有效");
    }
  }

  async function open(hub: Hub, current: HubBook) {
    setError("");
    setSlow(false);
    setScreen({ kind: "opening", hub });
    update({ ...current, lastHubId: hub.id });
    try {
      await openHub(hub.url);
    } catch (cause) {
      setScreen({ kind: "list" });
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    // Persists a packaged default that loadBook just added.
    update(book);
    const last = book.hubs.find((hub) => hub.id === book.lastHubId);
    if (claimLaunch() && book.openLastOnLaunch && last) void open(last, book);
  }, []);

  useEffect(() => {
    if (screen.kind !== "opening") return;
    const timer = window.setTimeout(() => setSlow(true), slowOpenMs);
    return () => window.clearTimeout(timer);
  }, [screen]);

  function save(hub: Hub) {
    const known = book.hubs.some((item) => item.id === hub.id);
    update({ ...book, hubs: known ? book.hubs.map((item) => (item.id === hub.id ? hub : item)) : [...book.hubs, hub] });
    setScreen({ kind: "list" });
  }

  function remove(hub: Hub) {
    const hubs = book.hubs.filter((item) => item.id !== hub.id);
    update({ ...book, hubs, lastHubId: book.lastHubId === hub.id ? null : book.lastHubId });
    if (!hubs.length) setScreen({ kind: "form", hub: null });
  }

  return (
    <main className="hub-picker">
      <div className="brand">
        <span className="brand-mark"><img className="brand-logo" src={logo} alt="" width={40} height={40} /></span>
        <span className="brand-wordmark">Clinavat</span>
      </div>
      <section className="hub-panel" aria-labelledby="hub-title">
        <header>
          <h1 id="hub-title">{screen.kind === "form" ? (screen.hub ? "编辑 Hub" : "添加 Hub") : "选择 Hub"}</h1>
          <p>客户端会打开所选 Hub 的工作台，之后可以随时切换到其他 Hub。</p>
        </header>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {screen.kind === "opening" ? (
          <div className="hub-opening" role="status">
            <LoaderCircle size={22} className="spin" />
            <strong>正在打开 {screen.hub.name}</strong>
            <span className="hub-url">{screen.hub.url}</span>
            {slow && <p>Hub 仍未响应。请检查网络，并确认这个地址已加入 Hub 的公开访问地址。</p>}
            <button className="button button-ghost" onClick={() => closeHub().catch(() => setScreen({ kind: "list" }))}>
              取消
            </button>
          </div>
        ) : screen.kind === "form" ? (
          <HubForm
            hub={screen.hub}
            hubs={book.hubs}
            onSave={save}
            onCancel={book.hubs.length ? () => setScreen({ kind: "list" }) : undefined}
          />
        ) : (
          <HubList
            book={book}
            onOpen={(hub) => void open(hub, book)}
            onAdd={() => setScreen({ kind: "form", hub: null })}
            onEdit={(hub) => setScreen({ kind: "form", hub })}
            onRemove={remove}
            onLaunchChange={(openLastOnLaunch) => update({ ...book, openLastOnLaunch })}
          />
        )}
      </section>
      <footer className="hub-footer">客户端 {__CLINAVAT_CLIENT_VERSION__}</footer>
    </main>
  );
}
