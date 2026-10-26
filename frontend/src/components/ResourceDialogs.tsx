import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  LoaderCircle,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { api, errorText, post } from "../api";
import type { DevHost, FileEntry, Overview } from "../types";
import { Modal } from "./Dialogs";
export { default as HostDialog } from "./hosts/HostDialog";
interface CreateProps {
  overview: Overview;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function ProjectDialog({
  overview,
  initialHost,
  onClose,
  onCreated,
}: CreateProps & { initialHost?: DevHost }) {
  const [hostId, setHostId] = useState(
    initialHost?.id || overview.hosts[0]?.id || "",
  );
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [directories, setDirectories] = useState<FileEntry[] | null>(null);
  const [browserPath, setBrowserPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function browse(target = path || "/") {
    if (!hostId) return;
    setBrowsing(true);
    setError("");
    try {
      const result = await api<{ path: string; entries: FileEntry[] }>(
        `/hosts/${hostId}/directories?path=${encodeURIComponent(target)}`,
      );
      setDirectories(result.entries);
      setBrowserPath(result.path);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBrowsing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/projects", { name, devHostId: hostId, remotePath: path });
      await onCreated();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="创建项目"
      subtitle="把远程目录映射为独立的协作工作区。"
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="form-section-icon">
          <FolderPlus size={22} />
          <span>新的项目空间</span>
        </div>
        <label>
          开发机
          <select
            value={hostId}
            onChange={(event) => {
              setHostId(event.target.value);
              setDirectories(null);
              setPath("");
            }}
            required
          >
            <option value="" disabled>
              选择开发机
            </option>
            {overview.hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name} · {host.username}@{host.host}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="给项目起一个名字"
            maxLength={100}
            required
          />
        </label>
        <label>
          远程目录
          <div className="input-with-button">
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="开发机上的绝对路径"
              required
              pattern="/.*"
            />
            <button
              type="button"
              disabled={browsing || !hostId}
              onClick={() => void browse()}
            >
              {browsing ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Folder size={15} />
              )}
              浏览
            </button>
          </div>
        </label>
        {directories && (
          <div className="directory-picker">
            <div className="directory-picker-heading">
              <button
                type="button"
                className="icon-button"
                onClick={() =>
                  void browse(
                    browserPath.split("/").slice(0, -1).join("/") || "/",
                  )
                }
                aria-label="上一级目录"
              >
                <ArrowLeft size={14} />
              </button>
              <span>{browserPath}</span>
              <button
                type="button"
                onClick={() => {
                  setPath(browserPath);
                  if (!name)
                    setName(
                      browserPath.split("/").filter(Boolean).at(-1) ||
                        "project",
                    );
                  setDirectories(null);
                }}
              >
                选择此目录
              </button>
            </div>
            <div>
              {directories.length ? (
                directories.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    onClick={() => void browse(entry.path)}
                  >
                    <Folder size={14} />
                    <span>{entry.name}</span>
                    <ChevronRight size={13} />
                  </button>
                ))
              ) : (
                <p>没有子目录</p>
              )}
            </div>
          </div>
        )}
        <div className="info-note">
          <ShieldCheck size={16} />
          <p>
            源码通过 Mutagen
            双向同步。依赖与构建产物留在开发机，终端命令始终远程执行。
          </p>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-ghost"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="button button-primary" disabled={busy || !hostId}>
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Plus size={15} />
            )}
            {busy ? "正在创建和同步…" : "创建项目"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
