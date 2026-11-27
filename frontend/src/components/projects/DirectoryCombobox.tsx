import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Folder, LoaderCircle } from "lucide-react";
import { api, errorText } from "../../api";
import type { FileEntry } from "../../types";

interface Listing {
  entries?: FileEntry[];
  error?: string;
}

type RawDirectoryEntry = FileEntry | string;

interface DirectoryResponse {
  path?: string;
  entries?: RawDirectoryEntry[];
  roots?: string[];
}

const visibleLimit = 80;
const windowsDrivePattern = /^[A-Za-z]:(?:[\\/]|$)/;
const windowsAbsolutePattern = /^[A-Za-z]:[\\/]/;

export function isAbsoluteDirectoryPath(value: string, allowWindows: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (allowWindows) return windowsAbsolutePattern.test(trimmed);
  return trimmed.startsWith("/");
}

function preferBackslash(path: string, isWindowsHost: boolean): boolean {
  if (!isWindowsHost) return false;
  if (path.includes("\\") || windowsDrivePattern.test(path)) return true;
  if (path.startsWith("/")) return false;
  return true;
}

function withTrailingSeparator(path: string, isWindowsHost: boolean): string {
  if (!path) return path;
  if (path.endsWith("/") || (isWindowsHost && path.endsWith("\\"))) return path;
  const sep = preferBackslash(path, isWindowsHost) ? "\\" : "/";
  return `${path}${sep}`;
}

function joinDirectoryPath(basePath: string, name: string, isWindowsHost: boolean): string {
  const cleanedName = name.replace(isWindowsHost ? /^[\\/]+/ : /^\/+/, "");
  if (!basePath) return cleanedName;
  return `${withTrailingSeparator(basePath, isWindowsHost)}${cleanedName}`;
}

function normalizeDirectoryEntries(
  entries: RawDirectoryEntry[] | undefined,
  basePath: string,
  allowWindows: boolean,
  isWindowsHost: boolean,
): FileEntry[] {
  if (!Array.isArray(entries)) return [];
  const normalized: FileEntry[] = [];
  for (const item of entries) {
    if (typeof item === "string") {
      const name = item.trim();
      if (!name) continue;
      normalized.push({
        name,
        path: joinDirectoryPath(basePath, name, isWindowsHost),
        type: "directory",
      });
      continue;
    }
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name) continue;
    const rawPath = typeof item.path === "string" && item.path.trim() ? item.path : "";
    const resolvedPath = rawPath && isAbsoluteDirectoryPath(rawPath, allowWindows)
      ? rawPath
      : joinDirectoryPath(basePath, rawPath || item.name, isWindowsHost);
    normalized.push({
      ...item,
      path: resolvedPath,
      type: item.type || "directory",
    });
  }
  return normalized;
}

function splitDirectoryPath(value: string, allowWindows: boolean): { parent: string; prefix: string } {
  const sepIndex = Math.max(value.lastIndexOf("/"), allowWindows ? value.lastIndexOf("\\") : -1);
  if (sepIndex < 0) return { parent: "", prefix: value };
  if (allowWindows && sepIndex === 2 && /^[A-Za-z]:$/.test(value.slice(0, 2))) {
    return { parent: value.slice(0, 3), prefix: value.slice(3) };
  }
  if (sepIndex === 0) {
    return { parent: value[0], prefix: value.slice(1) };
  }
  return { parent: value.slice(0, sepIndex), prefix: value.slice(sepIndex + 1) };
}

function resolveEntryPath(parent: string, entry: FileEntry, allowWindows: boolean, isWindowsHost: boolean): string {
  if (entry.path && isAbsoluteDirectoryPath(entry.path, allowWindows)) {
    return withTrailingSeparator(entry.path, isWindowsHost);
  }
  return withTrailingSeparator(joinDirectoryPath(parent, entry.name, isWindowsHost), isWindowsHost);
}

/**
 * Absolute path input that suggests subdirectories of the directory being typed, filtered by the last segment.
 * Supports POSIX paths as well as Windows drive paths and drive-root quick switching for Windows client hosts.
 */
export default function DirectoryCombobox({
  hostId,
  value,
  onChange,
  placeholder,
  disabled,
  allowWindows = false,
  isWindowsHost = false,
  hostOffline = false,
}: {
  hostId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  allowWindows?: boolean;
  isWindowsHost?: boolean;
  hostOffline?: boolean;
}) {
  const listboxId = useId();
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [roots, setRoots] = useState<string[]>([]);
  const [loading, setLoading] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const windowsMode = allowWindows || isWindowsHost;
  const { parent, prefix } = splitDirectoryPath(value, windowsMode);
  const listing = parent ? listings[parent] : undefined;

  useEffect(() => {
    setListings({});
    setRoots([]);
    if (!hostId || hostOffline) return;
    let cancelled = false;
    setLoading("~");
    api<DirectoryResponse>(`/hosts/${hostId}/directories`)
      .then((result) => {
        if (cancelled) return;
        const returnedRoots = Array.isArray(result.roots) ? result.roots.filter(Boolean) : [];
        if (returnedRoots.length) setRoots(returnedRoots);
        if (result.path) {
          const entries = normalizeDirectoryEntries(result.entries, result.path, windowsMode, windowsMode);
          setListings({ [result.path]: { entries } });
          if (!value) onChange(withTrailingSeparator(result.path, windowsMode));
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(""); });
    return () => { cancelled = true; };
  }, [hostId, hostOffline, windowsMode]);

  // The server serializes requests per host, so only one listing is fetched at a time.
  useEffect(() => {
    if (!hostId || hostOffline || loading || listing || !parent || !isAbsoluteDirectoryPath(value, windowsMode)) return;
    const timer = setTimeout(() => {
      setLoading(parent);
      api<DirectoryResponse>(`/hosts/${hostId}/directories?path=${encodeURIComponent(parent)}`)
        .then((result) => {
          if (Array.isArray(result.roots) && result.roots.length) setRoots(result.roots.filter(Boolean));
          const entries = normalizeDirectoryEntries(result.entries, result.path || parent, windowsMode, windowsMode);
          setListings((current) => ({ ...current, [parent]: { entries } }));
        })
        .catch((cause) => setListings((current) => ({ ...current, [parent]: { error: errorText(cause) } })))
        .finally(() => setLoading(""));
    }, 150);
    return () => clearTimeout(timer);
  }, [hostId, hostOffline, parent, loading, listing, value, windowsMode]);

  useEffect(() => setActive(-1), [parent, prefix]);

  const query = prefix.toLowerCase();
  const suggestions = (listing?.entries ?? [])
    .filter((entry) => (query.startsWith(".") || !entry.name.startsWith(".")) && entry.name.toLowerCase().includes(query))
    .sort((left, right) => Number(!left.name.toLowerCase().startsWith(query)) - Number(!right.name.toLowerCase().startsWith(query)))
    .slice(0, visibleLimit);
  const exact = suggestions.length === 1 && suggestions[0].name.toLowerCase() === query;
  const expanded = open && !disabled && !hostOffline && ((suggestions.length > 0 && !exact) || !!listing?.error || loading === parent);

  function choose(entry: FileEntry) {
    onChange(resolveEntryPath(parent, entry, windowsMode, windowsMode));
    setActive(-1);
  }

  function chooseRoot(root: string) {
    onChange(withTrailingSeparator(root, windowsMode && windowsDrivePattern.test(root)));
    setOpen(true);
    setActive(-1);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!expanded) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + suggestions.length) % suggestions.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && suggestions.length) {
      // Tab completes the first match like a shell, but still moves focus when nothing has been typed.
      const target = suggestions[active] ?? (event.key === "Tab" && prefix ? suggestions[0] : undefined);
      if (!target) return;
      event.preventDefault();
      choose(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="directory-combobox">
      {roots.length > 0 && (
        <div className="directory-roots" role="group" aria-label="快捷切换根目录或盘符">
          <span>盘符/根目录</span>
          {roots.map((root) => {
            const activeRoot = value.toUpperCase().startsWith(root.slice(0, 2).toUpperCase())
              && (root.length <= 3 || value.toUpperCase().startsWith(root.toUpperCase()));
            return (
              <button
                key={root}
                type="button"
                disabled={disabled || hostOffline}
                className={`directory-root-chip${activeRoot ? " active" : ""}`}
                onClick={() => chooseRoot(root)}
              >
                {root}
              </button>
            );
          })}
        </div>
      )}
      <input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={keyDown}
        placeholder={loading === "~" ? "正在读取主目录…" : placeholder}
        disabled={disabled}
        required
        pattern={windowsMode ? undefined : "/.*"}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={active >= 0 ? `${listboxId}-${active}` : undefined}
      />
      {expanded && (
        <div className="directory-suggestions" id={listboxId} role="listbox" onMouseDown={(event) => event.preventDefault()}>
          {loading === parent && !listing ? (
            <p><LoaderCircle size={13} className="spin" />正在读取 {parent}</p>
          ) : listing?.error ? (
            <p className="directory-suggestions-error">无法读取 {parent}：{listing.error}</p>
          ) : (
            suggestions.map((entry, index) => (
              <button
                type="button"
                key={entry.path || `${parent}/${entry.name}`}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? "active" : undefined}
                onClick={() => choose(entry)}
              >
                <Folder size={14} />
                <span>{entry.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
