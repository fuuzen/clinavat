import { useEffect, useRef, useState } from "react";
import type { Overview, Session } from "../../types";

export function useConversationSlot(
  overview: Overview,
  projectId: string | undefined,
  session: Session | undefined,
  onChange: (sessionId: string, slotId: string) => Promise<void>,
) {
  const [draftSlotId, setDraftSlotId] = useState("");
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current += 1;
    setSaving(false);
    setDraftSlotId(overview.slots.find((slot) => slot.status === "IDLE" && (!slot.in_use || slot.in_use_by_you))?.id || "");
  }, [projectId, session?.id]);
  const slotId = session ? session.slot_id || "" : draftSlotId;
  const slot = overview.slots.find((item) => item.id === slotId);
  async function changeSlot(nextId: string) {
    if (saving || nextId === slotId) return;
    if (!session) {
      setDraftSlotId(nextId);
      return;
    }
    const request = ++requestRef.current;
    setSaving(true);
    try { await onChange(session.id, nextId); }
    catch { /* The application reports the failed update and retains the saved slot. */ }
    finally { if (request === requestRef.current) setSaving(false); }
  }
  return { slot, slotId, slotSaving: saving, changeSlot };
}
