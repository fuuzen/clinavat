import { useCallback, useEffect, useState } from "react";
import { errorText, post } from "../api";
import { useSiteSettings } from "../site/store";
import type { ArchivedSessionItem, Overview, Session } from "../types";
import type { Notice } from "../components/AppNotices";
import Settings from "../components/Settings";
import { broadcastWindowEvent, subscribeWindowEvents } from "./channel";
import { closeCurrentWindow, focusMainWindow } from "./launcher";
import {
  buildDetachedWindowUrl,
  isValidSettingsTab,
  type SettingsTab,
  type SettingsWindowTarget,
} from "./types";

interface Props {
  target: SettingsWindowTarget;
  overview: Overview;
  onRefresh: () => Promise<void>;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
}

export default function SettingsWindow({ target, overview, onRefresh, onNotice }: Props) {
  const siteSettings = useSiteSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isValidSettingsTab(target.tab) ? target.tab : "account",
  );

  useEffect(() => {
    if (isValidSettingsTab(target.tab)) {
      setActiveTab(target.tab);
    }
  }, [target.tab]);

  useEffect(() => {
    document.title = `工作台设置 — ${siteSettings.name}`;
  }, [siteSettings.name]);

  const handleTabChange = useCallback((nextTab: SettingsTab) => {
    setActiveTab(nextTab);
    const nextUrl = buildDetachedWindowUrl({ kind: "settings", tab: nextTab });
    window.history.replaceState(null, "", nextUrl);
  }, []);

  useEffect(() => {
    return subscribeWindowEvents((message) => {
      if (message.type === "settings-tab" && isValidSettingsTab(message.tab)) {
        handleTabChange(message.tab);
      }
    });
  }, [handleTabChange]);

  const handleRefreshAndSync = useCallback(async () => {
    await onRefresh();
    broadcastWindowEvent({ type: "overview-changed", reason: "settings" });
  }, [onRefresh]);

  const handleOpenSession = useCallback((item: ArchivedSessionItem) => {
    broadcastWindowEvent({
      type: "open-session",
      sessionId: item.id,
      projectId: item.project_id,
    });
    focusMainWindow();
  }, []);

  const handleRestoreSession = useCallback(
    async (session: Session): Promise<boolean> => {
      try {
        await post<Session>(`/sessions/${session.id}/unarchive`);
        await onRefresh();
        broadcastWindowEvent({ type: "overview-changed", reason: "archived" });
        onNotice(`已恢复「${session.title}」`, "success");
        return true;
      } catch (cause) {
        onNotice(errorText(cause));
        return false;
      }
    },
    [onRefresh, onNotice],
  );

  const handleSessionDeleted = useCallback(
    (_sessionId: string) => {
      void onRefresh().catch(() => undefined);
      broadcastWindowEvent({ type: "overview-changed", reason: "archived" });
      onNotice("已删除", "success");
    },
    [onRefresh, onNotice],
  );

  return (
    <Settings
      overview={overview}
      standalone
      tab={activeTab}
      onTabChange={handleTabChange}
      onClose={() => closeCurrentWindow()}
      onFocusMain={() => focusMainWindow()}
      onRefresh={handleRefreshAndSync}
      onChanged={() => broadcastWindowEvent({ type: "overview-changed", reason: "settings" })}
      onNotice={onNotice}
      onOpenSession={handleOpenSession}
      onRestoreSession={handleRestoreSession}
      onSessionDeleted={handleSessionDeleted}
    />
  );
}
