import { AlertCircle, Check, X } from "lucide-react";

export interface Notice {
  id: number;
  content: string;
  kind: "error" | "success";
}

export default function AppNotices({ notices, onDismiss }: {
  notices: Notice[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="notices" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice-${notice.kind}`}>
          {notice.kind === "error" ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{notice.content}</span>
          <button className="icon-button" onClick={() => onDismiss(notice.id)} aria-label="关闭通知">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
