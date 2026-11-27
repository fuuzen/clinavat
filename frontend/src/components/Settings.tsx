import { lazy, Suspense, useState } from "react";
import {
  Archive,
  BarChart3,
  CircleUserRound,
  Home,
  MessageCircleQuestion,
  Palette,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import type { ArchivedSessionItem, Overview, Session } from "../types";
import type { SettingsTab } from "../windows/types";
import { Modal } from "./Dialogs";
import AccountSettings from "./settings/AccountSettings";
import RosterSettings from "./settings/RosterSettings";
import ServiceStatus from "./settings/ServiceStatus";
import QuestionSettings from "./settings/QuestionSettings";
import AgentDefaultsSettings from "./settings/AgentDefaultsSettings";
import TokenUsageSettings from "./settings/TokenUsageSettings";
import ArchivedSessionsSettings from "./settings/ArchivedSessionsSettings";

const AppearanceSettings = lazy(() => import("./settings/AppearanceSettings"));

interface Props {
  overview: Overview;
  standalone?: boolean;
  tab?: SettingsTab;
  initialTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  onClose: () => void;
  onFocusMain?: () => void;
  onRefresh: () => Promise<void>;
  onChanged?: () => void;
  onNotice?: (message: string, kind?: "error" | "success") => void;
  onOpenSession: (session: ArchivedSessionItem) => void;
  onRestoreSession: (session: Session) => Promise<boolean>;
  onSessionDeleted: (sessionId: string) => void;
}

export default function Settings({
  overview,
  standalone = false,
  tab: controlledTab,
  initialTab = "account",
  onTabChange,
  onClose,
  onFocusMain,
  onRefresh,
  onChanged,
  onNotice,
  onOpenSession,
  onRestoreSession,
  onSessionDeleted,
}: Props) {
  const [internalTab, setInternalTab] = useState<SettingsTab>(initialTab);
  const tab = controlledTab ?? internalTab;
  const selectTab = (next: SettingsTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const archivedCount = overview.archivedSessionsCount ?? 0;

  const content = (
    <div className={`settings-layout${standalone ? " is-standalone" : ""}`}>
      <nav className="settings-nav" aria-label="工作台设置">
        <button className={tab === "account" ? "active" : ""} onClick={() => selectTab("account")}>
          <CircleUserRound size={16} />
          我的账号
        </button>
        <button className={tab === "usage" ? "active" : ""} onClick={() => selectTab("usage")}>
          <BarChart3 size={16} />
          用量统计
        </button>
        <button className={tab === "conversation" ? "active" : ""} onClick={() => selectTab("conversation")}>
          <MessageCircleQuestion size={16} />
          对话默认值
        </button>
        <button className={tab === "roster" ? "active" : ""} onClick={() => selectTab("roster")}>
          <Users size={16} />
          智能体名册
        </button>
        <button className={tab === "archived" ? "active" : ""} onClick={() => selectTab("archived")}>
          <Archive size={16} />
          <span>已归档对话</span>
          {archivedCount > 0 && <span className="settings-nav-count">{archivedCount}</span>}
        </button>
        <button className={tab === "appearance" ? "active" : ""} onClick={() => selectTab("appearance")}>
          <Palette size={16} />
          外观与配色
        </button>
        <button className={tab === "system" ? "active" : ""} onClick={() => selectTab("system")}>
          <SlidersHorizontal size={16} />
          服务状态
        </button>
      </nav>
      <div className="settings-body">
        {tab === "appearance" && (
          <Suspense fallback={<div className="loading-state">正在加载外观设置…</div>}>
            <AppearanceSettings />
          </Suspense>
        )}
        {tab === "account" && (
          <AccountSettings overview={overview} onRefresh={onRefresh} onNotice={onNotice} />
        )}
        {tab === "usage" && <TokenUsageSettings />}
        {tab === "conversation" && (
          <>
            <AgentDefaultsSettings onChanged={onChanged} />
            <QuestionSettings onChanged={onChanged} />
          </>
        )}
        {tab === "roster" && <RosterSettings overview={overview} onChanged={onChanged} />}
        {tab === "archived" && (
          <ArchivedSessionsSettings
            overview={overview}
            onOpen={(item) => {
              onOpenSession(item);
              if (!standalone) onClose();
            }}
            onRestore={onRestoreSession}
            onDeleted={onSessionDeleted}
          />
        )}
        {tab === "system" && <ServiceStatus />}
      </div>
    </div>
  );

  if (standalone) {
    return (
      <section className="detached-window-surface detached-settings-window" aria-label="工作台设置">
        <header className="detached-window-header">
          <div>
            <h1>工作台设置</h1>
            <p>管理个人账号、对话默认值与已归档对话，查看用量、调整工作台外观与服务状态。</p>
          </div>
          <div className="detached-window-actions">
            {onFocusMain && (
              <button type="button" className="button button-ghost button-small" onClick={onFocusMain}>
                <Home size={14} />
                回到主窗口
              </button>
            )}
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭窗口" title="关闭窗口">
              <X size={17} />
            </button>
          </div>
        </header>
        {content}
      </section>
    );
  }

  return (
    <Modal
      title="工作台设置"
      subtitle="管理个人账号、对话默认值与已归档对话，查看用量、调整工作台外观与服务状态。"
      onClose={onClose}
      wide
    >
      {content}
    </Modal>
  );
}
