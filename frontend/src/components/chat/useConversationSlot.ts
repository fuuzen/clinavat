import { useEffect, useRef, useState } from "react";
import type { AccountSelection, Overview, Session, Slot } from "../../types";

const available = (slot: Slot) => slot.status === "IDLE" && (!slot.in_use || slot.in_use_by_you);

function initialSelection(slots: Slot[]): AccountSelection {
  const slot = slots.find(available) ?? slots[0];
  return !slot || slot.engine === "claude" ? { engine: "claude", slotMode: "auto" }
    : { engine: slot.engine, slotMode: "manual", slotId: slot.id };
}

export function useConversationSlot(
  overview: Overview,
  projectId: string | undefined,
  session: Session | undefined,
  onChange: (sessionId: string, selection: AccountSelection) => Promise<void>,
) {
  const [draftSelection, setDraftSelection] = useState(() => initialSelection(overview.slots));
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current += 1;
    setSaving(false);
    setDraftSelection(initialSelection(overview.slots));
  }, [projectId, session?.id]);
  const accountSelection: AccountSelection = session
    ? { engine: session.engine, slotMode: session.slot_mode, ...(session.slot_mode === "manual" && session.slot_id ? { slotId: session.slot_id } : {}) }
    : draftSelection;
  const slotId = session?.slot_id || accountSelection.slotId || "";
  const slot = overview.slots.find((item) => item.id === slotId);
  const candidates = overview.slots.filter(item => item.engine === accountSelection.engine && available(item));
  const catalogSlot = accountSelection.slotMode === "auto"
    ? candidates.find(item => item.id === slotId) ?? candidates[0] : slot;
  const slotAvailable = accountSelection.slotMode === "auto" ? candidates.length > 0
    : !!slot && slot.engine === accountSelection.engine && available(slot);
  async function changeSlot(next: AccountSelection) {
    if (saving || next.engine === accountSelection.engine && next.slotMode === accountSelection.slotMode
      && (next.slotMode === "auto" || next.slotId === accountSelection.slotId)) return;
    if (!session) {
      setDraftSelection(next);
      return;
    }
    const request = ++requestRef.current;
    setSaving(true);
    try { await onChange(session.id, next); }
    catch { /* The application reports the failed update and retains the saved slot. */ }
    finally { if (request === requestRef.current) setSaving(false); }
  }
  return { slot, slotId, accountSelection, catalogSlot, slotAvailable, slotSaving: saving, changeSlot };
}
