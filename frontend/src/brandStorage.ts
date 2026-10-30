export function legacyStorageKey(key: string) {
  return key.replace(/^clinavat(?=[:-])/, "cc-pool");
}

export function readBrandStorage(
  storage: Storage,
  key: string,
  migrateValue: (value: string) => string = (value) => value,
) {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const legacyKey = legacyStorageKey(key);
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return null;
  const value = migrateValue(legacy);
  try {
    storage.setItem(key, value);
    storage.removeItem(legacyKey);
  } catch {
    // The legacy copy remains readable when browser storage cannot accept the migration.
  }
  return value;
}

export function removeBrandStorage(storage: Storage, key: string) {
  // Remove the fallback first so a cleared draft cannot reappear on the next read.
  storage.removeItem(legacyStorageKey(key));
  storage.removeItem(key);
}
