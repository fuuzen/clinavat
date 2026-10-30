import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CircleUserRound, LoaderCircle, Search, UserRoundMinus } from "lucide-react";
import "../../styles/user-select.css";

export interface UserSelectOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
  unassigned?: boolean;
}

interface Props {
  options: UserSelectOption[];
  value: string | null;
  ariaLabel: string;
  searchLabel: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  title?: string;
}

interface Position { left: number; top: number; width: number; maxHeight: number; above: boolean }
const openEvent = "clinavat:user-select-open";

export default function UserSelect({ options, value, ariaLabel, searchLabel, onChange, placeholder = "选择用户", disabled = false, busy = false, className = "", title }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);
  const positioned = position !== null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = options.filter((option) => `${option.label} ${option.description || ""} ${option.keywords || ""}`.toLocaleLowerCase().includes(normalizedQuery));
  const active = matches.length ? Math.min(activeIndex, matches.length - 1) : -1;
  const unavailable = disabled || busy;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }
  function show(last = false) {
    if (unavailable) return;
    document.dispatchEvent(new CustomEvent(openEvent, { detail: id }));
    setQuery("");
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : last ? Math.max(0, options.length - 1) : 0);
    setPosition(null);
    setOpen(true);
  }
  function choose(option: UserSelectOption) {
    if (unavailable) return;
    close(true);
    onChange(option.value);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!matches.length) return;
      setActiveIndex(event.key === "Home" ? 0 : event.key === "End" ? matches.length - 1
        : (Math.max(0, active) + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === "Tab") {
      // The search field lives in a portal; continue tab order from its trigger.
      event.preventDefault();
      const elements = [...document.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.tabIndex >= 0 && element.getClientRects().length && !element.closest("[hidden], [inert]") && !menuRef.current?.contains(element));
      const index = elements.indexOf(triggerRef.current!);
      const next = elements[index + (event.shiftKey ? -1 : 1)];
      close();
      (next || triggerRef.current)?.focus();
    }
  }

  useEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);
  useEffect(() => {
    if (open && positioned) searchRef.current?.focus({ preventScroll: true });
  }, [open, positioned]);
  useEffect(() => {
    const otherOpened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    document.addEventListener(openEvent, otherOpened);
    return () => document.removeEventListener(openEvent, otherOpened);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close();
    };
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    function place() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft || 0;
      const y = viewport?.offsetTop || 0;
      const width = viewport?.width || innerWidth;
      const height = viewport?.height || innerHeight;
      if (rect.bottom < y || rect.top > y + height || rect.right < x || rect.left > x + width) { setOpen(false); return; }
      const menuWidth = Math.min(Math.max(rect.width, 240), width - 16);
      // Keep the list constrained while measuring so its scroll position survives.
      menu.style.width = `${menuWidth}px`;
      const style = getComputedStyle(menu);
      const children = [...menu.children];
      const spacing = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]
        .reduce((total, value) => total + (parseFloat(value) || 0), 0)
        + (parseFloat(style.rowGap) || 0) * Math.max(0, children.length - 1);
      const contentHeight = children.reduce((total, child) => total + Math.max(child.scrollHeight, child.getBoundingClientRect().height), 0);
      const desired = Math.min(360, contentHeight + spacing);
      const below = y + height - rect.bottom - 14;
      const aboveRoom = rect.top - y - 14;
      const above = below < Math.min(desired, 200) && aboveRoom > below;
      const maxHeight = Math.max(56, Math.min(360, above ? aboveRoom : below));
      const renderedHeight = Math.min(desired, maxHeight);
      const next = { left: Math.max(x + 8, Math.min(rect.left, x + width - menuWidth - 8)),
        top: above ? Math.max(y + 8, rect.top - renderedHeight - 6) : Math.min(rect.bottom + 6, y + height - renderedHeight - 8),
        width: menuWidth, maxHeight, above };
      setPosition((current) => current && Object.keys(next).every((key) => current[key as keyof Position] === next[key as keyof Position]) ? current : next);
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    const observer = new ResizeObserver(schedule);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, query, matches.length]);
  useEffect(() => {
    if (open && positioned && active >= 0) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, positioned, active]);

  return (
    <div className={`user-select ${className}`}>
      <button ref={triggerRef} type="button" className="slot-user-trigger user-select-trigger" aria-label={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-busy={busy}
        disabled={unavailable} title={title} onClick={() => open ? close() : show()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(event.key === "ArrowUp"); }
        }}>
        <CircleUserRound size={17} aria-hidden="true" /><span>{selected?.label || placeholder}</span>
        {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
      </button>
      {open && !unavailable && createPortal(
        <div ref={menuRef} className={`user-select-menu${position?.above ? " above" : ""}`} onKeyDown={keyboard}
          style={position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : { visibility: "hidden" }}>
          <label className="user-select-search"><Search size={14} aria-hidden="true" /><input ref={searchRef} type="search" role="combobox"
            aria-label={searchLabel} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`}
            aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
            placeholder="搜索用户名…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} /></label>
          <div ref={listRef} className="user-select-options" role="listbox" id={`${id}-list`} aria-label={ariaLabel}>
            {matches.map((option, index) => (
              <button key={option.value} id={`${id}-option-${index}`} type="button" role="option" aria-selected={option.value === value} tabIndex={-1}
                className={`user-select-option${option.value === value ? " selected" : ""}${index === active ? " active" : ""}`}
                onPointerMove={() => setActiveIndex(index)} onClick={() => choose(option)}>
                <span className={`user-select-avatar${option.unassigned ? " neutral" : ""}`} aria-hidden="true">{option.unassigned ? <UserRoundMinus size={15} /> : option.label.slice(0, 1).toUpperCase()}</span>
                <span className="user-select-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                <Check size={14} className="user-select-check" aria-hidden="true" />
              </button>
            ))}
          </div>
          {!matches.length && <p className="user-select-empty" role="status">没有匹配的用户</p>}
        </div>, document.body,
      )}
    </div>
  );
}
