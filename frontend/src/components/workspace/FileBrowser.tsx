import { useRef, useState, type DragEvent } from "react";
import { ArrowLeft, ChevronRight, FileUp, Folder, FolderUp, LoaderCircle, Upload } from "lucide-react";
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
  onUpload: (picked: PickedFiles) => void;
}

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export default function FileBrowser({ path, entries, busy, uploading, syncedMirror, onNavigate, onOpen, onUpload }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const pick = (input: HTMLInputElement) => {
    if (input.files?.length) onUpload(fromFileList(input.files));
    input.value = "";
  };
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
              <button key={entry.path} onClick={() => onOpen(entry)}>
                {entry.type === "directory" ? (
                  <Folder size={15} className="folder-icon" />
                ) : (
                  <FileIcon size={14} className={`tone-${kindInfo[detectKind(entry.path)].tone}`} />
                )}
                <span>{entry.name}</span>
                {entry.type === "directory" && <ChevronRight size={12} />}
              </button>
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
