import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import logo from "../../frontend/public/clinavat.svg";
import DaemonPanel from "./DaemonPanel";
import FingerprintDialog from "./FingerprintDialog";
import HubForm from "./HubForm";
import HubList from "./HubList";
import { claimLaunch, hubKeyFromUrl, loadBook, saveBook, type Hub, type HubBook } from "./hubs";
import {
  closeHub,
  confirmHostFingerprint,
  disconnectAllDaemons,
  disconnectHubDaemon,
  errorMessage,
  getDaemonStatus,
  openHub,
  reconnectHubDaemon,
  rejectHostFingerprint,
  setHubDaemonEnabled,
  syncKnownHubs,
  type DaemonBridgeSnapshot,
  type PendingFingerprintInfo,
} from "./native";

type Screen = { kind: "list" } | { kind: "form"; hub: Hub | null } | { kind: "opening"; hub: Hub };

// On Apple platforms a failed navigation leaves this page in place, so a stalled attempt is reported here.
const slowOpenMs = 15_000;
const daemonPollMs = 1500;

export default function App() {
  const [book, setBook] = useState(loadBook);
  const [screen, setScreen] = useState<Screen>(() => (book.hubs.length ? { kind: "list" } : { kind: "form", hub: null }));
  const [error, setError] = useState("");
  const [slow, setSlow] = useState(false);
  const [daemon, setDaemon] = useState<DaemonBridgeSnapshot | null>(null);
  const [daemonBusyKey, setDaemonBusyKey] = useState<string | null>(null);
  const [fpDialog, setFpDialog] = useState<PendingFingerprintInfo | null>(null);
  const [fpError, setFpError] = useState("");
  const [fpBusy, setFpBusy] = useState(false);

  const syncDaemonSnapshot = useCallback((snapshot: DaemonBridgeSnapshot) => {
    setDaemon(snapshot);
    const awaiting = snapshot.hubs
      .filter((item) => item.status === "awaiting_fingerprint" && item.pendingFingerprint)
      .map((item) => item.pendingFingerprint!);
    setFpDialog((current) => {
      if (current) {
        const stillPending = awaiting.find(
          (p) => p.hubKey === current.hubKey && p.hostKeyFingerprint === current.hostKeyFingerprint,
        );
        if (stillPending) return stillPending;
      }
      return awaiting[0] ?? null;
    });
  }, []);

  const refreshDaemon = useCallback(async () => {
    try {
      const snapshot = await getDaemonStatus();
      syncDaemonSnapshot(snapshot);
    } catch {
      // Outside Tauri webview (e.g. plain Vite preview) daemon commands are unavailable.
    }
  }, [syncDaemonSnapshot]);

  const syncHubsWithDaemon = useCallback(async (hubs: Hub[]) => {
    try {
      const snapshot = await syncKnownHubs(hubs.map((item) => item.url));
      syncDaemonSnapshot(snapshot);
    } catch {
      // Outside Tauri webview (e.g. plain Vite preview) daemon commands are unavailable.
    }
  }, [syncDaemonSnapshot]);

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
    // Persists a packaged default that loadBook just added, then reconciles known Hubs with the daemon store.
    update(book);
    void syncHubsWithDaemon(book.hubs);
    const last = book.hubs.find((hub) => hub.id === book.lastHubId);
    if (claimLaunch() && book.openLastOnLaunch && last) void open(last, book);
  }, []);

  useEffect(() => {
    if (!daemon?.supported || screen.kind !== "list") return;
    const timer = window.setInterval(() => void refreshDaemon(), daemonPollMs);
    return () => window.clearInterval(timer);
  }, [daemon?.supported, refreshDaemon, screen.kind]);

  useEffect(() => {
    if (screen.kind !== "opening") return;
    const timer = window.setTimeout(() => setSlow(true), slowOpenMs);
    return () => window.clearTimeout(timer);
  }, [screen]);

  async function runDaemonAction(key: string, action: () => Promise<DaemonBridgeSnapshot>) {
    setError("");
    setDaemonBusyKey(key);
    try {
      const next = await action();
      syncDaemonSnapshot(next);
      window.setTimeout(() => void refreshDaemon(), 350);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDaemonBusyKey(null);
    }
  }

  function save(hub: Hub) {
    const known = book.hubs.some((item) => item.id === hub.id);
    const nextHubs = known ? book.hubs.map((item) => (item.id === hub.id ? hub : item)) : [...book.hubs, hub];
    update({ ...book, hubs: nextHubs });
    void syncHubsWithDaemon(nextHubs);
    setScreen({ kind: "list" });
  }

  function remove(hub: Hub) {
    const hubs = book.hubs.filter((item) => item.id !== hub.id);
    update({ ...book, hubs, lastHubId: book.lastHubId === hub.id ? null : book.lastHubId });
    void syncHubsWithDaemon(hubs);
    if (!hubs.length) setScreen({ kind: "form", hub: null });
  }

  async function handleConfirmFingerprint(hubUrl: string, fingerprint: string) {
    setFpBusy(true);
    setFpError("");
    try {
      const next = await confirmHostFingerprint(hubUrl, fingerprint);
      syncDaemonSnapshot(next);
      setFpDialog(null);
      window.setTimeout(() => void refreshDaemon(), 350);
    } catch (cause) {
      setFpError(errorMessage(cause));
    } finally {
      setFpBusy(false);
    }
  }

  async function handleRejectFingerprint(hubUrl: string) {
    setFpBusy(true);
    setFpError("");
    try {
      const next = await rejectHostFingerprint(hubUrl);
      syncDaemonSnapshot(next);
      setFpDialog(null);
    } catch (cause) {
      setFpError(errorMessage(cause));
    } finally {
      setFpBusy(false);
    }
  }

  return (
    <main className="hub-picker">
      <div className="brand">
        <span className="brand-mark"><img className="brand-logo" src={logo} alt="" width={40} height={40} /></span>
        <span className="brand-wordmark">Clinavat</span>
      </div>
      <section className={`hub-panel${daemon?.supported ? " is-desktop" : ""}`} aria-labelledby="hub-title">
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
          <>
            {daemon?.supported && (
              <DaemonPanel
                snapshot={daemon}
                busy={daemonBusyKey !== null}
                onDisconnectAll={() => void runDaemonAction("*", disconnectAllDaemons)}
              />
            )}
            <HubList
              book={book}
              daemon={daemon}
              daemonBusyKey={daemonBusyKey}
              onOpen={(hub) => void open(hub, book)}
              onAdd={() => setScreen({ kind: "form", hub: null })}
              onEdit={(hub) => setScreen({ kind: "form", hub })}
              onRemove={remove}
              onLaunchChange={(openLastOnLaunch) => update({ ...book, openLastOnLaunch })}
              onToggleDaemon={(hub, enabled) =>
                void runDaemonAction(hubKeyFromUrl(hub.url), () => setHubDaemonEnabled(hub.url, enabled))
              }
              onReconnectDaemon={(hub) =>
                void runDaemonAction(hubKeyFromUrl(hub.url), () => reconnectHubDaemon(hub.url))
              }
              onDisconnectDaemon={(hub) =>
                void runDaemonAction(hubKeyFromUrl(hub.url), () => disconnectHubDaemon(hub.url))
              }
              onReviewFingerprint={(pending) => {
                setFpError("");
                setFpDialog(pending);
              }}
            />
          </>
        )}
      </section>
      <footer className="hub-footer">客户端 {__CLINAVAT_CLIENT_VERSION__}</footer>
      {fpDialog && (
        <FingerprintDialog
          pending={fpDialog}
          busy={fpBusy}
          error={fpError}
          onConfirm={(hubUrl, fp) => void handleConfirmFingerprint(hubUrl, fp)}
          onReject={(hubUrl) => void handleRejectFingerprint(hubUrl)}
        />
      )}
    </main>
  );
}
