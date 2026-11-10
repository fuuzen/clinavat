export interface Hub {
  id: string;
  name: string;
  url: string;
}

export interface HubBook {
  hubs: Hub[];
  lastHubId: string | null;
  openLastOnLaunch: boolean;
  /** The packaged default this installation has already added, so a Hub the user deleted stays deleted. */
  offeredDefault: string | null;
}

const storageKey = "clinavat-client-hubs";
const launchKey = "clinavat-client-launched";

function isHub(value: unknown): value is Hub {
  const hub = value as Partial<Hub> | null;
  return !!hub && typeof hub.id === "string" && typeof hub.name === "string" && typeof hub.url === "string";
}

export function newHubId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function loadBook(): HubBook {
  let stored: Partial<HubBook> = {};
  try {
    stored = (JSON.parse(localStorage.getItem(storageKey) || "{}") ?? {}) as Partial<HubBook>;
  } catch {
    stored = {};
  }
  return withPackagedDefault({
    hubs: Array.isArray(stored.hubs) ? stored.hubs.filter(isHub) : [],
    lastHubId: typeof stored.lastHubId === "string" ? stored.lastHubId : null,
    openLastOnLaunch: stored.openLastOnLaunch !== false,
    offeredDefault: typeof stored.offeredDefault === "string" ? stored.offeredDefault : null,
  });
}

// Each packaged address is offered once, so a build with a new default adds it without restoring deleted ones.
function withPackagedDefault(book: HubBook): HubBook {
  const preset = __CLINAVAT_DEFAULT_HUB__;
  if (!preset || book.offeredDefault === preset.url) return book;
  const existing = book.hubs.find((hub) => hub.url === preset.url);
  const hub = existing ?? { id: newHubId(), name: preset.name, url: preset.url };
  return {
    ...book,
    hubs: existing ? book.hubs : [...book.hubs, hub],
    lastHubId: book.lastHubId ?? hub.id,
    offeredDefault: preset.url,
  };
}

export function saveBook(book: HubBook) {
  localStorage.setItem(storageKey, JSON.stringify(book));
}

/** True only for the first load in an app session, so coming back to the list never reopens a Hub by itself. */
export function claimLaunch() {
  try {
    if (sessionStorage.getItem(launchKey)) return false;
    sessionStorage.setItem(launchKey, "1");
    return true;
  } catch {
    return false;
  }
}
