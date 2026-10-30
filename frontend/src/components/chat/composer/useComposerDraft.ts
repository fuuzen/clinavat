import { useCallback, useSyncExternalStore } from "react";
import {
  getComposerDraftKey,
  readComposerDraft,
  subscribeComposerDraft,
  writeComposerDraft,
} from "./draftStorage";

export function useComposerDraft(userId: string, projectId?: string, sessionId?: string) {
  const draftKey = getComposerDraftKey(userId, projectId, sessionId);
  const subscribe = useCallback((callback: () => void) => subscribeComposerDraft(draftKey, callback), [draftKey]);
  const getSnapshot = useCallback(() => readComposerDraft(draftKey), [draftKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const setDraft = useCallback((value: string) => writeComposerDraft(draftKey, value), [draftKey]);
  return { draftKey, draft: snapshot.text, setDraft, snapshot, storageError: snapshot.storageError };
}
