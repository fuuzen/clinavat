import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Folder, LoaderCircle } from "lucide-react";
import { api, errorText } from "../../api";
import type { FileEntry } from "../../types";

interface Listing {
  entries?: FileEntry[];
  error?: string;
}

const visibleLimit = 80;

function splitPath(value: string) {
  const slash = value.lastIndexOf("/");
  return { parent: value.slice(0, slash) || "/", prefix: value.slice(slash + 1) };
}

function withTrailingSlash(path: string) {
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * Absolute path input that suggests the subdirectories of the directory being typed, filtered by the last segment.
 * An empty value is filled with the login user's home directory.
 */
export default function DirectoryCombobox({
  hostId,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  hostId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const listboxId = useId();
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [loading, setLoading] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { parent, prefix } = splitPath(value);
  const listing = listings[parent];
  useEffect(() => {
    setListings({});
    if (!hostId) return;
    let cancelled = false;
    setLoading("~");
    api<{ path: string; entries: FileEntry[] }>(`/hosts/${hostId}/directories`)
      .then((result) => {
        if (cancelled) return;
        setListings({ [result.path]: { entries: result.entries } });
        if (!value) onChange(withTrailingSlash(result.path));
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(""); });
    return () => { cancelled = true; };
  }, [hostId]);
  // The server serializes requests per host, so only one listing is fetched at a time.
  useEffect(() => {
    if (!hostId || loading || listing || !value.startsWith("/")) return;
    const timer = setTimeout(() => {
      setLoading(parent);
      api<{ entries: FileEntry[] }>(`/hosts/${hostId}/directories?path=${encodeURIComponent(parent)}`)
        .then((result) => setListings((current) => ({ ...current, [parent]: { entries: result.entries } })))
        .catch((cause) => setListings((current) => ({ ...current, [parent]: { error: errorText(cause) } })))
        .finally(() => setLoading(""));
    }, 150);
    return () => clearTimeout(timer);
  }, [hostId, parent, loading, listing, value]);
  useEffect(() => setActive(-1), [parent, prefix]);
  const query = prefix.toLowerCase();
  const suggestions = (listing?.entries ?? [])
    .filter((entry) => (query.startsWith(".") || !entry.name.startsWith(".")) && entry.name.toLowerCase().includes(query))
    .sort((left, right) => Number(!left.name.toLowerCase().startsWith(query)) - Number(!right.name.toLowerCase().startsWith(query)))
    .slice(0, visibleLimit);
  const exact = suggestions.length === 1 && suggestions[0].name === prefix;
  const expanded = open && !disabled && ((suggestions.length > 0 && !exact) || !!listing?.error || loading === parent);
  function choose(entry: FileEntry) {
    onChange(withTrailingSlash(entry.path));
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
        pattern="/.*"
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
                key={entry.path}
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
