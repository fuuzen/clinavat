import { useState } from "react";
import {
  CircleUserRound,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import type { Overview } from "../types";
import { Modal } from "./Dialogs";
import AccountSettings from "./settings/AccountSettings";
import SlotManagement from "./settings/SlotManagement";
import UserManagement from "./settings/UserManagement";
import ServiceStatus from "./settings/ServiceStatus";

interface Props {
  overview: Overview;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

export default function Settings({ overview, onClose, onRefresh }: Props) {
  const [tab, setTab] = useState<"account" | "users" | "slots" | "system">(
    "account",
  );
  const admin = overview.user.role === "admin";
  return (
    <Modal
      title="工作台设置"
      subtitle="管理你的连接、团队账号和服务状态。"
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
          {admin && (
            <>
              <button
                className={tab === "users" ? "active" : ""}
                onClick={() => setTab("users")}
              >
                <Users size={16} />
                用户管理
              </button>
              <button
                className={tab === "slots" ? "active" : ""}
                onClick={() => setTab("slots")}
              >
                <ShieldCheck size={16} />
                账号槽位
              </button>
            </>
          )}
          <button
            className={tab === "system" ? "active" : ""}
            onClick={() => setTab("system")}
          >
            <SlidersHorizontal size={16} />
            服务状态
          </button>
        </nav>
        <div className="settings-body">
          {tab === "account" && (
            <AccountSettings
              overview={overview}
              onSlots={() => setTab("slots")}
            />
          )}
          {tab === "users" && admin && (
            <UserManagement
              onRefresh={onRefresh}
              onSlots={() => setTab("slots")}
            />
          )}
          {tab === "slots" && admin && <SlotManagement onRefresh={onRefresh} />}
          {tab === "system" && <ServiceStatus />}
        </div>
      </div>
    </Modal>
  );
}
