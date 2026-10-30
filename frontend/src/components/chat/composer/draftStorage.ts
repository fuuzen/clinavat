import { legacyStorageKey, readBrandStorage, removeBrandStorage } from "../../../brandStorage";

export interface ComposerDraftSnapshot {
  text: string;
  revision: string;
  storageError?: string;
}

interface DraftEntry {
  snapshot: ComposerDraftSnapshot;
  storedValue: string | null;
  unsaved: boolean;
}

const storagePrefix = "clinavat-composer-draft:v1:";
const storageWarning = "草稿暂时无法保存到浏览器；当前页面内仍会保留，请勿刷新或关闭页面。";
const emptyDraft: ComposerDraftSnapshot = { text: "", revision: "" };
const entries = new Map<string, DraftEntry>();
const subscribers = new Map<string, Set<() => void>>();
let revisionSequence = 0;

export function getComposerDraftKey(userId: string, projectId?: string, sessionId?: string) {
  return projectId ? `${storagePrefix}${JSON.stringify([userId, projectId, sessionId || null])}` : null;
}

function createRevision() {
  return `${Date.now()}:${++revisionSequence}:${Math.random().toString(36).slice(2)}`;
}

function parseDraft(value: string | null): ComposerDraftSnapshot {
  if (value === null) return emptyDraft;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("text" in parsed) || !("revision" in parsed) ||
    typeof parsed.text !== "string" || typeof parsed.revision !== "string")
    throw new Error("Invalid composer draft");
  return { text: parsed.text, revision: parsed.revision };
}

export function readComposerDraft(key: string | null): ComposerDraftSnapshot {
  if (!key) return emptyDraft;
  const cached = entries.get(key);
  if (cached?.unsaved) return cached.snapshot;
  try {
    const storedValue = readBrandStorage(window.localStorage, key);
    if (cached && cached.storedValue === storedValue && !cached.snapshot.storageError)
      return cached.snapshot;
    const snapshot = parseDraft(storedValue);
    entries.set(key, { snapshot, storedValue, unsaved: false });
    return snapshot;
  } catch {
    if (cached?.snapshot.storageError) return cached.snapshot;
    const snapshot = { ...(cached?.snapshot || emptyDraft), storageError: storageWarning };
    entries.set(key, { snapshot, storedValue: cached?.storedValue ?? null, unsaved: false });
    return snapshot;
  }
}

function notify(key: string) {
  subscribers.get(key)?.forEach((callback) => callback());
}

function persistDraft(key: string, snapshot: ComposerDraftSnapshot) {
  const storedValue = snapshot.text ? JSON.stringify({ text: snapshot.text, revision: snapshot.revision }) : null;
  let saved = true;
  try {
    if (storedValue === null) removeBrandStorage(window.localStorage, key);
    else window.localStorage.setItem(key, storedValue);
  } catch {
    saved = false;
  }
  entries.set(key, {
    snapshot: saved ? snapshot : { ...snapshot, storageError: storageWarning },
    storedValue: saved ? storedValue : entries.get(key)?.storedValue ?? null,
    unsaved: !saved,
  });
  notify(key);
  return saved;
}

export function writeComposerDraft(key: string | null, text: string) {
  if (!key) return;
  const current = readComposerDraft(key);
  if (current.text === text && !current.storageError) return;
  persistDraft(key, { text, revision: createRevision() });
}

function matchesDraft(current: ComposerDraftSnapshot, expected: ComposerDraftSnapshot) {
  return current.revision === expected.revision && current.text === expected.text;
}

export function clearComposerDraft(key: string | null, expected: ComposerDraftSnapshot) {
  if (!key || !matchesDraft(readComposerDraft(key), expected)) return false;
  return persistDraft(key, emptyDraft);
}

export function moveComposerDraft(
  fromKey: string | null,
  toKey: string | null,
  expected?: ComposerDraftSnapshot,
) {
  if (!fromKey || !toKey || fromKey === toKey) return false;
  const source = readComposerDraft(fromKey);
  if (!source.text || (expected && !matchesDraft(source, expected))) return false;
  const destination = readComposerDraft(toKey);
  const snapshot = !destination.text
    ? { text: source.text, revision: source.revision }
    : destination.text === source.text
      ? { text: destination.text, revision: destination.revision }
      : { text: `${destination.text}\n\n${source.text}`, revision: createRevision() };
  // Keep the original durable copy if the destination cannot be saved.
  if (!persistDraft(toKey, snapshot)) return false;
  clearComposerDraft(fromKey, source);
  return true;
}

function onStorage(event: StorageEvent) {
  const legacyPrefix = legacyStorageKey(storagePrefix);
  const currentKey = event.key?.startsWith(legacyPrefix)
    ? storagePrefix + event.key.slice(legacyPrefix.length) : event.key;
  if (currentKey !== null && !currentKey.startsWith(storagePrefix)) return;
  const keys = currentKey === null ? [...subscribers.keys()] : [currentKey];
  for (const key of keys) {
    // Unpersisted local edits remain recoverable even if another tab saves its copy.
    if (entries.get(key)?.unsaved) continue;
    readComposerDraft(key);
    notify(key);
  }
}

export function subscribeComposerDraft(key: string | null, callback: () => void) {
  if (!key) return () => {};
  if (!subscribers.size) window.addEventListener("storage", onStorage);
  const listeners = subscribers.get(key) || new Set<() => void>();
  listeners.add(callback);
  subscribers.set(key, listeners);
  return () => {
    listeners.delete(callback);
    if (!listeners.size) subscribers.delete(key);
    if (!subscribers.size) window.removeEventListener("storage", onStorage);
  };
}
