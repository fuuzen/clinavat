import {
  ArrowUpRight,
  Box,
  Clock3,
  Cpu,
  HardDrive,
  Info,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import type { AdminHealth } from "./types";
import MobileCardDetails from "./MobileCardDetails";
import "../../styles/admin-host.css";

interface Props {
  health: AdminHealth | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}

function RuntimeStatus({ available, loading }: { available?: boolean; loading: boolean }) {
  const label = available === undefined
    ? loading ? "检测中" : "未获取"
    : available ? "可用" : "不可用";
  return <span className={`admin-status${available === undefined ? "" : available ? " success" : " warning"}`}>
    <span className="admin-host-status-dot" aria-hidden="true" />{label}
  </span>;
}

export default function HostManagement({ health, loading, error, onRefresh }: Props) {
  return (
    <div className="admin-host-page">
      <div className="admin-host-actions">
        <button className="button button-secondary button-small" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : ""} />刷新状态
        </button>
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="admin-card admin-host-service" aria-label="号池服务状态">
        <div className="admin-host-service-identity">
          <span className="admin-host-icon admin-host-icon-large"><Server size={25} /></span>
          <div>
            <h3>Clinavat 宿主机</h3>
            <p>承载账号槽位、智能体执行与工作区同步</p>
          </div>
        </div>
        <div className="admin-host-service-meta">
          <div><span>服务状态</span><RuntimeStatus available={health ? health.status === "ok" : undefined} loading={loading} /></div>
          <div><span>服务版本</span><strong>{health ? `v${health.version}` : "—"}</strong></div>
          <div><span>运行时长</span><strong className="admin-host-pending">待采集</strong></div>
        </div>
      </section>

      <section aria-labelledby="admin-host-runtime-heading">
        <div className="admin-host-section-heading">
          <div><h3 id="admin-host-runtime-heading">CLI 运行环境</h3><p>统一查看智能体引擎与基础依赖的可用性。</p></div>
          <span className="admin-host-section-label">2 个智能体引擎</span>
        </div>
        <div className="admin-host-engines">
          {([
            { key: "claude", name: "Claude Code", letter: "✳", description: "Claude 官方命令行运行环境" },
            { key: "codex", name: "Codex", letter: ">_", description: "Codex 官方命令行运行环境" },
          ] as const).map((engine) => (
            <article className="admin-card admin-host-engine" key={engine.key}>
              <div className="admin-host-engine-heading">
                <span className={`admin-host-engine-mark ${engine.key}`} aria-hidden="true">{engine.letter}</span>
                <div className="admin-host-engine-identity"><h4>{engine.name}</h4></div>
                <RuntimeStatus available={health?.runtime[engine.key]} loading={loading} />
              </div>
              <MobileCardDetails label={engine.name} summary={<span className="admin-host-engine-summary">已安装版本 <strong>待采集</strong></span>}>
                <p className="admin-host-engine-description">{engine.description}</p>
                <div className="admin-host-engine-version">
                  <div><span>已安装版本</span><strong>待采集</strong></div>
                  <span className="admin-host-pending-label">版本检测待接入</span>
                </div>
                <div className="admin-host-engine-footer">
                  <span><ShieldCheck size={13} />授权在账号槽位中管理</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </div>
              </MobileCardDetails>
            </article>
          ))}
        </div>
        <div className="admin-card admin-host-dependencies">
          <div><span className="admin-host-icon"><Box size={17} /></span><div><strong>Mutagen</strong><small>工作区双向同步</small></div><RuntimeStatus available={health?.runtime.mutagen} loading={loading} /></div>
          <div><span className="admin-host-icon"><Terminal size={17} /></span><div><strong>OpenSSH</strong><small>开发机安全连接</small></div><RuntimeStatus available={health?.runtime.ssh} loading={loading} /></div>
        </div>
      </section>

      <section aria-labelledby="admin-host-resource-heading">
        <div className="admin-host-section-heading">
          <div><h3 id="admin-host-resource-heading">资源与容量</h3><p>为宿主机保留充足的运行与存储空间。</p></div>
          <span className="admin-status">监控待接入</span>
        </div>
        <div className="admin-host-resources">
          <article className="admin-card admin-host-storage">
            <div className="admin-card-heading"><HardDrive size={18} /><h4>磁盘空间</h4><span className="admin-host-pending-label">待采集</span></div>
            <div className="admin-host-storage-value"><strong>—</strong><span>可用 / 总容量待采集</span></div>
            <div className="admin-host-capacity-placeholder" aria-hidden="true" />
            <div className="admin-host-storage-legend"><span>工作区与镜像</span><span>账号数据</span><span>系统与其他</span></div>
            <p className="admin-host-resource-note">接入磁盘采集后，显示剩余容量与各类目录占用。</p>
          </article>
          <div className="admin-host-resource-stack">
            {[
              { icon: Cpu, label: "CPU", detail: "使用率与核心数" },
              { icon: MemoryStick, label: "内存", detail: "已用 / 总内存" },
              { icon: Clock3, label: "系统运行时间", detail: "最近启动与持续运行时间" },
            ].map(({ icon: Icon, label, detail }) => (
              <article className="admin-card admin-host-resource" key={label}>
                <span className="admin-host-icon"><Icon size={18} /></span>
                <div><h4>{label}</h4><p>{detail}</p></div>
                <span className="admin-host-pending">待采集</span>
              </article>
            ))}
          </div>
        </div>
        <div className="admin-host-monitor-note"><Info size={15} /><p>服务与 CLI 可用性来自实时检测；版本详情和资源指标将在接入宿主机监控后展示。</p></div>
      </section>

      <section className="admin-card admin-host-maintenance" aria-labelledby="admin-host-maintenance-heading">
        <span className="admin-host-icon"><Wrench size={19} /></span>
        <div><h3 id="admin-host-maintenance-heading">维护操作</h3><p>维护能力待接入，后续可在这里检查更新、整理存储和重启服务。</p></div>
        <button className="button button-secondary button-small" disabled>检查更新</button>
      </section>
    </div>
  );
}
