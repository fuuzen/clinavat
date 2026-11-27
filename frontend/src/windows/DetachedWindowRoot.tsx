import { useCallback, useEffect, useState } from "react";
import { AlertCircle, LoaderCircle, LogOut } from "lucide-react";
import { api, ApiError, errorText } from "../api";
import { loadSiteSettings } from "../site/store";
import type { Overview } from "../types";
import AppNotices, { type Notice } from "../components/AppNotices";
import { broadcastWindowEvent, subscribeWindowEvents } from "./channel";
import { closeCurrentWindow } from "./launcher";
import { detachedWindowKey, type DetachedWindowTarget } from "./types";
import PreviewWindow from "./PreviewWindow";
import SettingsWindow from "./SettingsWindow";
import MemoryWindow from "./MemoryWindow";

interface Props {
  target: DetachedWindowTarget;
}

/**
 * Entry root for detached desktop windows (`?window=preview|settings|memory`).
 * Deliberately never mounts `App` and never opens an `/api/events` SSE stream;
 * cross-window state stays in sync over the same-origin `BroadcastChannel`.
 */
export default function DetachedWindowRoot({ target }: Props) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);

  const notify = useCallback((content: string, kind: Notice["kind"] = "error") => {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current.slice(-3), { id, content, kind }]);
    window.setTimeout(
      () => setNotices((current) => current.filter((item) => item.id !== id)),
      6000,
    );
  }, []);

  const handleUnauthorized = useCallback(() => {
    setUnauthorized(true);
    setOverview(null);
    closeCurrentWindow();
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      const next = await api<Overview>("/overview");
      setOverview(next);
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        handleUnauthorized();
        return;
      }
      throw cause;
    }
  }, [handleUnauthorized]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      void loadSiteSettings().catch(() => undefined);
      await refreshOverview();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [refreshOverview]);

  useEffect(() => {
    broadcastWindowEvent({ type: "window-ready", key: detachedWindowKey(target) });
  }, [target]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const onUnauthorized = () => handleUnauthorized();
    window.addEventListener("clinavat:unauthorized", onUnauthorized);
    const unsubscribe = subscribeWindowEvents((message) => {
      if (message.type === "logout") {
        handleUnauthorized();
      } else if (message.type === "overview-changed") {
        void refreshOverview().catch(() => undefined);
      }
    });
    return () => {
      window.removeEventListener("clinavat:unauthorized", onUnauthorized);
      unsubscribe();
    };
  }, [handleUnauthorized, refreshOverview]);

  if (unauthorized) {
    return (
      <div className="detached-window-state">
        <LogOut size={24} />
        <strong>登录状态已失效</strong>
        <p>正在关闭独立窗口，请在主窗口重新登录。</p>
        <button type="button" className="button button-secondary" onClick={() => closeCurrentWindow()}>
          关闭窗口
        </button>
      </div>
    );
  }

  if (loading && !overview) {
    return (
      <div className="detached-window-state">
        <LoaderCircle size={22} className="spin" />
        <span>正在加载窗口…</span>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="detached-window-state">
        <AlertCircle size={24} />
        <strong>无法加载窗口内容</strong>
        <p>{error}</p>
        <div className="detached-window-state-actions">
          <button type="button" className="button button-primary" onClick={() => void initialize()}>
            重试
          </button>
          <button type="button" className="button button-ghost" onClick={() => closeCurrentWindow()}>
            关闭窗口
          </button>
        </div>
      </div>
    );
  }

  if (!overview) return null;

  return (
    <div className="detached-window-shell">
      {target.kind === "preview" && (
        <PreviewWindow
          target={target}
          overview={overview}
          onNotice={notify}
        />
      )}
      {target.kind === "settings" && (
        <SettingsWindow
          target={target}
          overview={overview}
          onRefresh={refreshOverview}
          onNotice={notify}
        />
      )}
      {target.kind === "memory" && (
        <MemoryWindow
          target={target}
          overview={overview}
          onNotice={notify}
        />
      )}
      <AppNotices
        notices={notices}
        onDismiss={(id) => setNotices((current) => current.filter((notice) => notice.id !== id))}
      />
    </div>
  );
}
