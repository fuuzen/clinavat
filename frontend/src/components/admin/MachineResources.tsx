import { useEffect, useState } from "react";
import { Check, Cpu, LoaderCircle, RefreshCw, RotateCcw, Save } from "lucide-react";
import { api, errorText, post } from "../../api";
import DangerDialog from "../settings/DangerDialog";
import "../../styles/admin-machines.css";

type MachineKind = "slot" | "workspace";
interface Resources { cpu: number; memoryMiB: number; diskGiB: number }
type ResourceSettings = Record<MachineKind, Resources>;
interface QuotaUsage { usage: number; limit: number | null }
interface MachineView {
  name: string;
  kind: MachineKind;
  owner: string;
  label: string | null;
  status: string;
  current: { cpu: number | null; memoryMiB: number | null; diskGiB: number | null };
  pending: string[];
  blocked: string[];
  error: string | null;
}
interface ResourceView {
  available: boolean;
  settings: ResourceSettings;
  machines: MachineView[];
  quota: Record<"cpu" | "memory" | "disk" | "virtualMachines" | "containers", QuotaUsage | null> | null;
}
interface Draft { cpu: string; memoryGiB: string; diskGiB: string }

const kinds = [
  { kind: "slot", label: "槽位虚拟机", note: "每个账号槽位一台，CLI 在其中运行" },
  { kind: "workspace", label: "用户工作区容器", note: "每个有项目的用户一个，负责同步" },
] as const;
const GiB = 2 ** 30;
const toDraft = (resources: Resources): Draft => ({
  cpu: String(resources.cpu), memoryGiB: String(Math.round((resources.memoryMiB / 1024) * 100) / 100), diskGiB: String(resources.diskGiB),
});
const fromDraft = (draft: Draft): Resources => ({
  cpu: Number(draft.cpu), memoryMiB: Math.round(Number(draft.memoryGiB) * 1024), diskGiB: Number(draft.diskGiB),
});
const gib = (value: number | null) => value === null ? "不限" : `${Math.round(value * 100) / 100} GiB`;

function Quota({ label, quota, bytes }: { label: string; quota: QuotaUsage | null; bytes?: boolean }) {
  if (!quota) return null;
  const show = (value: number) => bytes ? gib(value / GiB) : String(value);
  const ratio = quota.limit ? Math.min(1, quota.usage / quota.limit) : 0;
  return (
    <div className="admin-machines-quota">
      <span>{label}</span>
      <strong>{show(quota.usage)}<small> / {quota.limit === null ? "不限" : show(quota.limit)}</small></strong>
      {quota.limit !== null && <i className={ratio >= 0.9 ? "warning" : ""}><b style={{ width: `${ratio * 100}%` }} /></i>}
    </div>
  );
}

/** CPU, memory and root disk for every slot VM and workspace container; LXD counts them against the project quota. */
export default function MachineResources() {
  const [view, setView] = useState<ResourceView | null>(null);
  const [drafts, setDrafts] = useState<Record<MachineKind, Draft> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [restarting, setRestarting] = useState<{ machine: MachineView; rebuild: boolean } | null>(null);
  function show(value: ResourceView) {
    setView(value);
    setDrafts({ slot: toDraft(value.settings.slot), workspace: toDraft(value.settings.workspace) });
  }
  async function load(signal?: AbortSignal) {
    setBusy(true); setError("");
    try { show(await api<ResourceView>("/admin/machine-resources", { signal })); }
    catch (cause) { if (!signal?.aborted) setError(errorText(cause)); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  const draft = drafts && { slot: fromDraft(drafts.slot), workspace: fromDraft(drafts.workspace) };
  const dirty = !!view && !!draft && JSON.stringify(draft) !== JSON.stringify(view.settings);

  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const saved = await api<ResourceView>("/admin/machine-resources", { method: "PUT", body: JSON.stringify(draft) });
      show(saved);
      setMessage(saved.machines.some((machine) => machine.pending.length || machine.blocked.length || machine.error)
        ? "已保存。部分实例要重启或重建后才生效，见下方列表。" : "已保存，所有实例均已生效。");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  return (
    <section className="admin-card admin-site-section admin-machines" aria-labelledby="admin-machines-heading" aria-busy={busy}>
      <div className="admin-card-heading">
        <div><Cpu size={17} /><h3 id="admin-machines-heading">实例资源</h3></div>
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={14} className={busy ? "spin" : ""} />刷新
        </button>
      </div>
      {view && !view.available ? (
        <p className="admin-site-description">当前为宿主机执行模式，CLI 和同步直接在宿主机上运行，没有需要分配资源的实例。</p>
      ) : (
        <>
          <p className="admin-site-description">
            LXD 项目配额按每个实例的上限累加，已关机的实例也计入。保存后，已关机的实例和运行中的工作区容器立即调整；
            运行中的槽位虚拟机要重启后生效。虚拟机磁盘不能缩小，只能重建：槽位的登录和文件保存在宿主机上，重建不会丢失。
            容器磁盘缩小要等容器下次关机。项目总配额由宿主机管理员用 <code>lxc project set</code> 调整。
          </p>
          {view?.quota && (
            <div className="admin-machines-quotas">
              <Quota label="vCPU" quota={view.quota.cpu} />
              <Quota label="内存" quota={view.quota.memory} bytes />
              {view.quota.disk?.limit !== null && <Quota label="磁盘" quota={view.quota.disk} bytes />}
              <Quota label="虚拟机" quota={view.quota.virtualMachines} />
              <Quota label="容器" quota={view.quota.containers} />
            </div>
          )}
          {drafts && (
            <form className="admin-machines-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              {kinds.map(({ kind, label, note }) => (
                <fieldset key={kind} disabled={busy}>
                  <legend>{label}<small>{note}</small></legend>
                  {([["cpu", "vCPU", "个", 1, 64, 1], ["memoryGiB", "内存", "GiB", 0.25, 256, 0.25], ["diskGiB", "磁盘", "GiB", 2, 2048, 1]] as const)
                    .map(([field, name, unit, min, max, step]) => (
                      <label key={field}>
                        {name}
                        <span><input type="number" required min={min} max={max} step={step} value={drafts[kind][field]}
                          onChange={(event) => { setDrafts({ ...drafts, [kind]: { ...drafts[kind], [field]: event.target.value } }); setMessage(""); }} />{unit}</span>
                      </label>
                    ))}
                </fieldset>
              ))}
              <div className="admin-site-access-actions">
                <span>新建的实例直接按此创建</span>
                <button type="submit" className="button button-primary button-small" disabled={busy || !dirty}>
                  {busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存并应用
                </button>
              </div>
            </form>
          )}
          {error && <p className="admin-site-access-error" role="alert">{error}</p>}
          {message && <p className="admin-site-access-status" role="status"><Check size={13} />{message}</p>}
          {view && view.machines.length > 0 && (
            <div className="admin-machines-table-wrap">
              <table className="admin-machines-table">
                <thead><tr><th>实例</th><th>状态</th><th>vCPU</th><th>内存</th><th>磁盘</th><th>待生效</th><th /></tr></thead>
                <tbody>
                  {view.machines.map((machine) => (
                    <tr key={machine.name}>
                      <td>
                        <strong>{machine.label ?? machine.owner}</strong>
                        <small>{machine.kind === "slot" ? "槽位虚拟机" : "工作区容器"} · <code>{machine.name}</code></small>
                      </td>
                      <td><span className={`admin-status${machine.status === "Running" ? " success" : ""}`}>{machine.status === "Running" ? "运行中" : machine.status === "Stopped" ? "已关机" : machine.status}</span></td>
                      <td>{machine.current.cpu ?? "—"}</td>
                      <td>{machine.current.memoryMiB === null ? "—" : gib(machine.current.memoryMiB / 1024)}</td>
                      <td>{gib(machine.current.diskGiB)}</td>
                      <td className="admin-machines-changes">
                        {[...machine.pending, ...machine.blocked].join("；") || (machine.error ? "" : "已生效")}
                        {machine.error && <small role="alert">{machine.error}</small>}
                      </td>
                      <td>
                        {machine.kind === "slot" && (machine.blocked.length > 0 || machine.pending.length > 0) && (
                          <button type="button" className="button button-secondary button-small" disabled={busy}
                            onClick={() => setRestarting({ machine, rebuild: machine.blocked.length > 0 })}>
                            <RotateCcw size={13} />{machine.blocked.length > 0 ? "重建" : "重启以应用"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {restarting && (
        <DangerDialog title={restarting.rebuild ? "重建槽位虚拟机" : "重启槽位虚拟机"} subtitle={restarting.machine.label ?? restarting.machine.owner}
          actionLabel={restarting.rebuild ? "删除并重建" : "关机"} danger={restarting.rebuild}
          onClose={() => setRestarting(null)}
          onConfirm={async () => {
            show(await post<ResourceView>(`/admin/machine-resources/slots/${encodeURIComponent(restarting.machine.owner)}/restart`, { rebuild: restarting.rebuild }));
            setMessage(restarting.rebuild ? "虚拟机已删除，下次使用该槽位时按新配额重建。" : "虚拟机已关机并调整，下次使用该槽位时自动启动。");
          }}>
          <p>
            {restarting.rebuild
              ? "将删除这台虚拟机，下次使用该槽位时按新配额重新创建。登录、主目录和固定地址保留在宿主机上，虚拟机内另外安装的软件会丢失。"
              : "将关闭这台虚拟机并应用新配额，下次使用该槽位时自动启动。"}
            槽位必须空闲：有对话正在运行或正在查询额度时会拒绝操作。
          </p>
        </DangerDialog>
      )}
    </section>
  );
}
