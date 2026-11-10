import { useState } from "react";
import { Archive, ArchiveRestore, LoaderCircle } from "lucide-react";
import type { Session } from "../../types";

/** Takes the composer's place: an archived conversation can be read but takes no input until restored. */
export default function ArchivedNotice({ session, onRestore }: { session: Session; onRestore: (session: Session) => Promise<void> }) {
  const [restoring, setRestoring] = useState(false);
  return (
    <div className="composer-area">
      <div className="archived-notice" role="status">
        <Archive size={15} aria-hidden="true" />
        <span>此对话已归档，只能查看。恢复后可以继续对话。</span>
        <button type="button" className="button button-secondary button-small" disabled={restoring}
          onClick={() => { setRestoring(true); void onRestore(session).finally(() => setRestoring(false)); }}>
          {restoring ? <LoaderCircle size={13} className="spin" /> : <ArchiveRestore size={13} />}
          恢复对话
        </button>
      </div>
    </div>
  );
}
