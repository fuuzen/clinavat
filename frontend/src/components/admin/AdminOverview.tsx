import { ArrowRight, ArrowUpRight, Boxes, Check, CircleDot, Globe2, HardDrive, Network, RefreshCw, Server, ShieldCheck, Users } from "lucide-react";
import { BrandMark } from "../Brand";
import type { Overview, Slot, User } from "../../types";
import type { AdminHealth, AdminTab } from "./types";

interface Props {
  overview: Overview;
  health: AdminHealth | null;
  users: User[] | null;
  slots: Slot[] | null;
  loading: boolean;
  onNavigate: (tab: AdminTab) => void;
  onRefresh: () => void;
}

export default function AdminOverview({ overview, health, users, slots, loading, onNavigate, onRefresh }: Props) {
  const hosts = overview.hosts.filter((host) => host.kind !== "local");
  const connected = hosts.filter((host) => host.status === "CONNECTED").length;
  const available = slots?.filter((slot) => slot.status === "IDLE" && !slot.in_use && !slot.active_user_id).length;
  const occupied = slots?.filter((slot) => slot.in_use || slot.active_user_id).length;
  const stats = [
    { label: "团队成员", value: users?.length, scope: "全站", detail: users ? `${users.filter((user) => user.role === "admin").length} 位管理员 · ${users.filter((user) => user.role !== "admin").length} 位成员` : "正在获取成员信息", icon: Users, tab: "users" as const },
    { label: "账号槽位", value: slots?.length, scope: "全站", detail: slots ? `${available} 个可用 · ${occupied} 个使用中` : "正在获取账号信息", icon: ShieldCheck, tab: "slots" as const },
    { label: "Workspaces", value: overview.projects.length, scope: "当前账号", detail: `${overview.sessions.length} 个对话 · ${overview.hosts.length} 个开发环境`, icon: Boxes, tab: "workspaces" as const },
    { label: "开发机连接", value: hosts.length, scope: "当前账号", detail: `${connected} 台已连接 · ${hosts.length - connected} 台未连接`, icon: Network, tab: "connections" as const },
  ];
  const shortcuts = [
    { tab: "site" as const, icon: Globe2, label: "打造你的工作台", detail: "站点名称、登录页与品牌外观", badge: "个性化" },
    { tab: "workspaces" as const, icon: Boxes, label: "管理项目空间", detail: "查看项目分布、同步与会话", badge: "Workspaces" },
    { tab: "slots" as const, icon: Users, label: "管理账号槽位", detail: "查看额度，在卡片中分配使用者", badge: "账号" },
  ];
  return (
    <div className="admin-overview">
      <div className="admin-module-toolbar"><span className="admin-scope-label"><CircleDot size={12} />用户与槽位为全站数据</span>
        <button type="button" className="icon-button" disabled={loading} onClick={onRefresh} aria-label="刷新概览" title="刷新概览"><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
      </div>
      <div className="admin-stats">
        {stats.map(({ label, value, scope, detail, icon: Icon, tab }) => (
          <button className="admin-stat" key={tab} onClick={() => onNavigate(tab)}>
            <span className="admin-stat-top"><Icon size={17} /><span>{scope}</span><ArrowUpRight size={13} /></span>
            <strong>{value ?? "—"}<span>{label}</span></strong>
            <small>{value === undefined ? loading ? "正在加载…" : "暂时无法获取，请刷新重试" : detail}</small>
          </button>
        ))}
      </div>
      <div className="admin-overview-grid">
        <section className="admin-card admin-environment-card">
          <div className="admin-card-heading"><div><Server size={17} /><h3>运行环境</h3></div><button className="text-button" onClick={() => onNavigate("host")}>查看宿主机<ArrowUpRight size={13} /></button></div>
          <div className="admin-service-summary"><span className="admin-service-symbol"><BrandMark size={32} /></span><div><strong>Clinavat 控制服务</strong><small>统一调度 Claude Code 与 Codex</small></div><span className={`admin-status ${health?.status === "ok" ? "success" : ""}`}>{health ? health.status === "ok" ? "服务正常" : "状态异常" : loading ? "检测中" : "未获取"}</span></div>
          <div className="admin-runtime-list">
            {([{ key: "claude", name: "Claude Code", description: "Anthropic CLI" }, { key: "codex", name: "Codex", description: "OpenAI CLI" }, { key: "mutagen", name: "文件同步", description: "Mutagen" }, { key: "ssh", name: "远程连接", description: "OpenSSH" }] as const).map((runtime) => (
              <div key={runtime.key}><span className={`admin-runtime-dot ${health?.runtime[runtime.key] ? "available" : ""}`} /><strong>{runtime.name}</strong><small>{runtime.description}</small><span className={health?.runtime[runtime.key] ? "positive-text" : "admin-muted"}>{health ? health.runtime[runtime.key] ? "可用" : "不可用" : "—"}</span></div>
            ))}
          </div>
          <div className="admin-environment-footer"><span>服务版本 <code>{health ? `v${health.version}` : "—"}</code></span><span>CLI 版本与系统指标待采集</span></div>
        </section>
        <section className="admin-card admin-shortcuts-card">
          <div className="admin-card-heading"><div><Globe2 size={17} /><h3>管理快捷入口</h3></div></div>
          {shortcuts.map(({ tab, icon: Icon, label, detail, badge }) => (
            <button className="admin-shortcut" key={tab} onClick={() => onNavigate(tab)}><span className="admin-shortcut-icon"><Icon size={19} /></span><span><small>{badge}</small><strong>{label}</strong><span>{detail}</span></span><ArrowRight size={16} /></button>
          ))}
        </section>
      </div>
      <section className="admin-preview-note">
        <span className="admin-preview-note-icon"><HardDrive size={20} /></span>
        <div><strong>一个独立的管理空间</strong><p>个人外观与账号设置留在工作台。品牌与登录页在「站点个性化」管理，公开域名在「网关和访问」配置。</p></div>
        <button className="text-button" onClick={() => onNavigate("site")}>预览站点外观<ArrowRight size={14} /></button>
      </section>
      <div className="admin-overview-footnote"><Check size={13} />返回工作台后，可以继续当前项目与对话。</div>
    </div>
  );
}
