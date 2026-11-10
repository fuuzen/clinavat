import { useState } from "react";
import { Pencil, Plus, Server, Trash2, X } from "lucide-react";
import type { Hub, HubBook } from "./hubs";

interface Props {
  book: HubBook;
  onOpen: (hub: Hub) => void;
  onAdd: () => void;
  onEdit: (hub: Hub) => void;
  onRemove: (hub: Hub) => void;
  onLaunchChange: (openLastOnLaunch: boolean) => void;
}

export default function HubList({ book, onOpen, onAdd, onEdit, onRemove, onLaunchChange }: Props) {
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <>
      <ul className="hub-list">
        {book.hubs.map((hub) => (
          <li key={hub.id} className="hub-item">
            <button className="hub-open" onClick={() => onOpen(hub)}>
              <Server size={18} />
              <span className="hub-label">
                <strong>{hub.name}</strong>
                <small>{hub.url}</small>
              </span>
              {hub.url.startsWith("http:") && <span className="badge badge-amber">未加密</span>}
              {hub.id === book.lastHubId && <span className="badge">上次使用</span>}
            </button>
            {removing === hub.id ? (
              <>
                <button className="button button-danger button-small" onClick={() => onRemove(hub)}>删除</button>
                <button className="icon-button" onClick={() => setRemoving(null)} title="保留" aria-label="保留">
                  <X size={15} />
                </button>
              </>
            ) : (
              <>
                <button className="icon-button" onClick={() => onEdit(hub)} title="编辑" aria-label={`编辑 ${hub.name}`}>
                  <Pencil size={15} />
                </button>
                <button className="icon-button" onClick={() => setRemoving(hub.id)} title="删除" aria-label={`删除 ${hub.name}`}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <button className="button button-ghost hub-add" onClick={onAdd}>
        <Plus size={16} />
        添加 Hub
      </button>
      <label className="hub-launch">
        <input type="checkbox" checked={book.openLastOnLaunch} onChange={(event) => onLaunchChange(event.target.checked)} />
        启动时自动打开上次使用的 Hub
      </label>
    </>
  );
}
