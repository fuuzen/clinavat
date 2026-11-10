import { lazy, Suspense, useState } from "react";
import {
  CircleUserRound,
  MessageCircleQuestion,
  Palette,
  SlidersHorizontal,
} from "lucide-react";
import type { Overview } from "../types";
import { Modal } from "./Dialogs";
import AccountSettings from "./settings/AccountSettings";
import ServiceStatus from "./settings/ServiceStatus";
import QuestionSettings from "./settings/QuestionSettings";

const AppearanceSettings = lazy(() => import("./settings/AppearanceSettings"));

interface Props {
  overview: Overview;
  onClose: () => void;
}

export default function Settings({ overview, onClose }: Props) {
  const [tab, setTab] = useState<"account" | "conversation" | "appearance" | "system">(
    "account",
  );
  return (
    <Modal
      title="工作台设置"
      subtitle="管理个人账号和对话默认值、调整工作台外观，查看连接与服务状态。"
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
            className={tab === "conversation" ? "active" : ""}
            onClick={() => setTab("conversation")}
          >
            <MessageCircleQuestion size={16} />
            对话默认值
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
          {tab === "conversation" && <QuestionSettings />}
          {tab === "system" && <ServiceStatus />}
        </div>
      </div>
    </Modal>
  );
}
