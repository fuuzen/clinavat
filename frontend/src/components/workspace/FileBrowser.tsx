import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, FileUp, Folder, FolderUp, LoaderCircle, Upload } from "lucide-react";
import type { FileEntry } from "../../types";
import { detectKind, iconFor, kindInfo } from "../preview/fileKinds";
import { fromDrop, fromFileList, type PickedFiles } from "./pickedFiles";

interface Props {
  path: string;
  entries: FileEntry[];
  busy: boolean;
  uploading: boolean;
  syncedMirror: boolean;
  onNavigate: (path: string) => void;
  onOpen: (entry: FileEntry) => void;
  onOpenDetached?: (entry: FileEntry) => void;
  onUpload: (picked: PickedFiles) => void;
}

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export default function FileBrowser({
  path,
  entries,
  busy,
  uploading,
  syncedMirror,
  onNavigate,
  onOpen,
  onOpenDetached,
  onUpload,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => {
    if (clickTimer.current !== undefined) clearTimeout(clickTimer.current);
  }, []);

  const pick = (input: HTMLInputElement) => {
    if (input.files?.length) onUpload(fromFileList(input.files));
    input.value = "";
  };

  function handleEntryClick(entry: FileEntry, event: MouseEvent<HTMLButtonElement>) {
    if (entry.type === "directory" || !onOpenDetached) {
      onOpen(entry);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      if (clickTimer.current !== undefined) clearTimeout(clickTimer.current);
      onOpenDetached(entry);
      return;
    }
    if (event.detail >= 2) {
      if (clickTimer.current !== undefined) clearTimeout(clickTimer.current);
      onOpenDetached(entry);
      return;
    }
    if (clickTimer.current !== undefined) clearTimeout(clickTimer.current);
    // Brief delay lets desktop double-clicks open a detached window before inline preview mounts.
    clickTimer.current = setTimeout(() => {
      clickTimer.current = undefined;
      onOpen(entry);
    }, 180);
  }

  const sorted = [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  return (
    <div
      className={`file-listing${dragging ? " dragging" : ""}`}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = uploading ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        if (!uploading) void fromDrop(event.dataTransfer).then(onUpload);
      }}
    >
      <div className="file-breadcrumb">
        {path ? (
          <button
            className="icon-button"
            onClick={() => onNavigate(path.split("/").slice(0, -1).join("/"))}
            aria-label="上一级目录"
          >
            <ArrowLeft size={14} />
          </button>
        ) : (
          <ChevronRight size={13} />
        )}
        <span title={path}>{path || "项目根目录"}</span>
        <span className="file-count">{entries.length}</span>
        <div className="file-upload-actions">
          <button className="icon-button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label="上传文件" title="上传文件到当前目录">
            <FileUp size={14} />
          </button>
          <button className="icon-button" onClick={() => folderInput.current?.click()} disabled={uploading} aria-label="上传文件夹" title="上传文件夹到当前目录">
            <FolderUp size={14} />
          </button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => pick(event.currentTarget)} />
        <input
          ref={(node) => {
            folderInput.current = node;
            if (node) node.webkitdirectory = true;
          }}
          type="file"
          hidden
          onChange={(event) => pick(event.currentTarget)}
        />
      </div>
      {busy ? (
        <div className="loading-state">
          <LoaderCircle size={18} className="spin" />
        </div>
      ) : entries.length === 0 ? (
        <div className="inspector-empty small">
          <Folder size={25} />
          <p>
            这个目录暂时没有文件。
            <br />
            {syncedMirror && "首次同步可能需要一些时间。"}
            {syncedMirror && <br />}
            把文件拖到这里即可上传。
          </p>
        </div>
      ) : (
        <div className="file-list">
          {sorted.map((entry) => {
            const FileIcon = iconFor(entry.path);
            return (
              <div key={entry.path} className="file-list-row">
                <button
                  className="file-list-entry"
                  onClick={(event) => handleEntryClick(entry, event)}
                  title={entry.type === "file" && onOpenDetached ? `${entry.name}（双击在独立窗口中打开）` : entry.name}
                >
                  {entry.type === "directory" ? (
                    <Folder size={15} className="folder-icon" />
                  ) : (
                    <FileIcon size={14} className={`tone-${kindInfo[detectKind(entry.path)].tone}`} />
                  )}
                  <span>{entry.name}</span>
                  {entry.type === "directory" && <ChevronRight size={12} />}
                </button>
                {entry.type === "file" && onOpenDetached && (
                  <button
                    type="button"
                    className="icon-button file-detach-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenDetached(entry);
                    }}
                    title="在独立窗口中打开"
                    aria-label={`在独立窗口中打开 ${entry.name}`}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {dragging && (
        <div className="file-drop-overlay">
          <Upload size={22} />
          <strong>{uploading ? "请等待当前上传完成" : "松开以上传"}</strong>
          {!uploading && <span>到 {path || "项目根目录"}</span>}
        </div>
      )}
    </div>
  );
}
