import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Boxes, Globe2, LayoutDashboard, Menu, Network, Server, ShieldCheck, Users, Waypoints } from "lucide-react";
import { api, errorText } from "../../api";
import { useSiteSettings } from "../../site/store";
import type { DevHost, Overview, Project, Slot, User } from "../../types";
import UserManagement from "../settings/UserManagement";
import SlotManagement from "../settings/SlotManagement";
import AdminOverview from "./AdminOverview";
import SiteSettings from "./SiteSettings";
import HostManagement from "./HostManagement";
import GatewayManagement from "./GatewayManagement";
import ResourceManagement from "./ResourceManagement";
import type { AdminHealth, AdminTab } from "./types";

interface Props {
  overview: Overview;
  onRefresh: () => Promise<void>;
  onSidebar: () => void;
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
  onNewHost: () => void;
  onEditHost: (host: DevHost) => void;
  onConnect: (host: DevHost) => Promise<void>;
}

const tabs = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "site", label: "站点个性化", icon: Globe2 },
  { id: "host", label: "宿主机", icon: Server },
  { id: "gateway", label: "网关和访问", icon: Waypoints },
  { id: "workspaces", label: "Workspaces", icon: Boxes },
  { id: "connections", label: "开发机连接", icon: Network },
  { id: "users", label: "用户与权限", icon: Users },
  { id: "slots", label: "槽位管理", icon: ShieldCheck },
] satisfies { id: AdminTab; label: string; icon: typeof Server }[];

export default function AdminPanel(props: Props) {
  const siteSettings = useSiteSettings();
  const [tab, setTab] = useState<AdminTab>("overview");
  const [siteVisited, setSiteVisited] = useState(false);
  const [gatewayVisited, setGatewayVisited] = useState(false);
  const [resourceUserId, setResourceUserId] = useState(props.overview.user.id);
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [healthError, setHealthError] = useState("");
  const loadingRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const results = await Promise.allSettled([
      api<AdminHealth>("/health"), api<User[]>("/admin/users"), api<Slot[]>("/admin/slots"),
    ]);
    const [serviceResult, usersResult, slotsResult] = results;
    setHealth(serviceResult.status === "fulfilled" ? serviceResult.value : null);
    setHealthError(serviceResult.status === "rejected" ? errorText(serviceResult.reason) : "");
    setUsers(usersResult.status === "fulfilled" ? usersResult.value : null);
    setSlots(slotsResult.status === "fulfilled" ? slotsResult.value : null);
    setErrors(results.flatMap((result, index) => result.status === "rejected"
      ? [`${["服务状态", "用户列表", "账号槽位"][index]}：${errorText(result.reason)}`] : []));
    loadingRef.current = false;
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
    tabListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [tab]);
  const refresh = useCallback(async () => {
    await Promise.all([load(), props.onRefresh()]);
  }, [load, props.onRefresh]);

  function selectTab(next: AdminTab) {
    if (next === "site") setSiteVisited(true);
    if (next === "gateway") setGatewayVisited(true);
    setTab(next);
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!offset && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + offset + tabs.length) % tabs.length;
    selectTab(tabs[next].id);
    tabListRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  return (
    <main className="admin-panel" aria-label="管理面板">
      <div className="admin-navigation">
        <button className="icon-button mobile-only" onClick={props.onSidebar} aria-label="打开侧栏"><Menu size={18} /></button>
        <div className="admin-tabs" role="tablist" aria-label="管理模块" ref={tabListRef}>
          {tabs.map(({ id, label, icon: Icon }, index) => (
            <button key={id} id={`admin-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`admin-page-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => moveTab(event, index)} onClick={() => selectTab(id)} className={tab === id ? "active" : ""}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
      </div>
      <div className="admin-content" ref={contentRef}>
        {errors.length > 0 && <div className="inline-error" role="alert">{errors.join("；")}</div>}
        {tabs.map(({ id }) => (
          <section key={id} id={`admin-page-${id}`} role="tabpanel" aria-labelledby={`admin-tab-${id}`} hidden={tab !== id} tabIndex={0}>
            {id === "overview" && tab === id && <AdminOverview overview={props.overview} health={health} users={users} slots={slots} loading={loading} onNavigate={selectTab}
              onRefresh={() => void refresh().catch((cause) => setErrors((current) => [...current, errorText(cause)]))} />}
            {id === "site" && siteVisited && <SiteSettings userId={props.overview.user.id} />}
            {id === "gateway" && gatewayVisited && <GatewayManagement />}
            {id === "host" && tab === id && <HostManagement health={health} loading={loading} error={healthError} onRefresh={() => void load()} />}
            {(id === "workspaces" || id === "connections") && tab === id && <ResourceManagement kind={id} overview={props.overview} users={users} selectedUserId={resourceUserId} onSelectUser={setResourceUserId} onOpenProject={props.onOpenProject} onNewProject={props.onNewProject} onNewHost={props.onNewHost} onEditHost={props.onEditHost} onConnect={props.onConnect} onRefresh={refresh} refreshing={loading} />}
            {id === "users" && tab === id && <div className="admin-existing-module"><UserManagement onRefresh={refresh} onSlots={() => selectTab("slots")} /></div>}
            {id === "slots" && tab === id && <div className="admin-existing-module"><SlotManagement onRefresh={refresh} /></div>}
          </section>
        ))}
        <footer className="admin-footer"><span>{siteSettings.name} <span> / </span> ADMINISTRATION</span><span><ShieldCheck size={12} />仅管理员可访问</span></footer>
      </div>
    </main>
  );
}
