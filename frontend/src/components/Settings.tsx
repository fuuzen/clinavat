import { lazy, Suspense, useState } from "react";
import { Archive, BarChart3, CircleUserRound, MessageCircleQuestion, Palette, SlidersHorizontal, Users } from "lucide-react";
import type { ArchivedSessionItem, Overview, Session } from "../types";
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
  onClose: () => void;
  onOpenSession: (session: ArchivedSessionItem) => void;
  onRestoreSession: (session: Session) => Promise<boolean>;
  onSessionDeleted: (sessionId: string) => void;
}

export default function Settings({ overview, onClose, onOpenSession, onRestoreSession, onSessionDeleted }: Props) {
  const [tab, setTab] = useState<
    "account" | "usage" | "conversation" | "roster" | "archived" | "appearance" | "system"
  >("account");
  const archivedCount = overview.archivedSessionsCount ?? 0;
  return (
    <Modal
      title="工作台设置"
      subtitle="管理个人账号、对话默认值与已归档对话，查看用量、调整工作台外观与服务状态。"
      onClose={onClose}
      wide
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="工作台设置">
          <button
            className={tab === "account" ? "active" : ""}
            onClick={() => setTab("account")}
          >
            <CircleUserRound size={16} />
            我的账号
          </button>
          <button
            className={tab === "usage" ? "active" : ""}
            onClick={() => setTab("usage")}
          >
            <BarChart3 size={16} />
            用量统计
          </button>
          <button
            className={tab === "conversation" ? "active" : ""}
            onClick={() => setTab("conversation")}
          >
            <MessageCircleQuestion size={16} />
            对话默认值
          </button>
          <button
            className={tab === "roster" ? "active" : ""}
            onClick={() => setTab("roster")}
          >
            <Users size={16} />
            智能体名册
          </button>
          <button
            className={tab === "archived" ? "active" : ""}
            onClick={() => setTab("archived")}
          >
            <Archive size={16} />
            <span>已归档对话</span>
            {archivedCount > 0 && <span className="settings-nav-count">{archivedCount}</span>}
          </button>
          <button
            className={tab === "appearance" ? "active" : ""}
            onClick={() => setTab("appearance")}
          >
            <Palette size={16} />
            外观与配色
          </button>
          <button
            className={tab === "system" ? "active" : ""}
            onClick={() => setTab("system")}
          >
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
            <AccountSettings overview={overview} />
          )}
          {tab === "usage" && <TokenUsageSettings />}
          {tab === "conversation" && (
            <>
              <AgentDefaultsSettings />
              <QuestionSettings />
            </>
          )}
          {tab === "roster" && <RosterSettings overview={overview} />}
          {tab === "archived" && (
            <ArchivedSessionsSettings
              overview={overview}
              onOpen={(item) => {
                onOpenSession(item);
                onClose();
              }}
              onRestore={onRestoreSession}
              onDeleted={onSessionDeleted}
            />
          )}
          {tab === "system" && <ServiceStatus />}
        </div>
      </div>
    </Modal>
  );
}
