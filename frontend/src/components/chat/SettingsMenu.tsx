import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface Props {
  openRequest?: number;
  label: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  role?: "menu" | "dialog";
  align?: "start" | "end";
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}

const SettingsPath = createContext<string[]>([]);

interface Position {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function enabledItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
  )).filter((item) => !item.matches(':disabled, [aria-disabled="true"], [hidden]'));
}

function focusItem(menu: HTMLElement, item: HTMLElement) {
  item.focus({ preventScroll: true });
  const itemBox = item.getBoundingClientRect();
  const menuBox = menu.getBoundingClientRect();
  const top = itemBox.top - menuBox.top - menu.clientTop;
  const bottom = itemBox.bottom - menuBox.top - menu.clientTop - menu.clientHeight;
  if (top < 0) menu.scrollTop += top;
  else if (bottom > 0) menu.scrollTop += bottom;
}

export default function SettingsMenu(props: Props) {
  const menuId = useId();
  const parentPath = useContext(SettingsPath);
  const settingsPath = [...parentPath, menuId];
  const role = props.role || "menu";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"selected" | "last">("selected");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const lastOpenRequest = useRef(props.openRequest);
  useEffect(() => {
    if (lastOpenRequest.current === props.openRequest) return;
    lastOpenRequest.current = props.openRequest;
    if (props.openRequest && !props.disabled) setOpen(true);
  }, [props.openRequest, props.disabled]);

  const dismiss = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => dismiss(true), [dismiss]);
  const focusSelection = useCallback((menu: HTMLElement) => {
    if (role === "dialog") {
      const target = menu.querySelector<HTMLElement>('input:not(:disabled)')
        || menu.querySelector<HTMLElement>('button:not(:disabled)');
      (target || menu).focus({ preventScroll: true });
      return;
    }
    const items = enabledItems(menu);
    const selected = items.filter((item) => item.getAttribute("aria-checked") === "true").at(-1);
    const target = initialFocus.current === "last" ? items.at(-1) : selected || items[0];
    if (target) focusItem(menu, target);
    else menu.focus({ preventScroll: true });
  }, [role]);

  useEffect(() => {
    if (props.disabled) dismiss(false);
  }, [props.disabled, dismiss]);

  useLayoutEffect(() => {
    if (!open || props.disabled) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    function updatePosition() {
      if (!menu || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      const gutter = 12;
      const gap = 8;
      const width = Math.max(0, Math.min(320, viewportWidth - gutter * 2));
      const above = Math.max(0, anchor.top - viewportTop - gap - gutter);
      const below = Math.max(0, viewportTop + viewportHeight - anchor.bottom - gap - gutter);
      const naturalHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
      const placeAbove = above >= Math.min(160, naturalHeight) || above >= below;
      const maxHeight = placeAbove ? above : below;
      const height = Math.min(naturalHeight, maxHeight);
      const next = {
        top: placeAbove ? anchor.top - gap - height : anchor.bottom + gap,
        left: Math.max(viewportLeft + gutter, Math.min(
          props.align === "end" ? anchor.right - width : anchor.left,
          viewportLeft + viewportWidth - gutter - width,
        )),
        width,
        maxHeight,
      };
      setPosition((previous) => previous &&
        previous.top === next.top && previous.left === next.left &&
        previous.width === next.width && previous.maxHeight === next.maxHeight
        ? previous : next);
    }
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    let lastFocused: HTMLElement | undefined;
    const trackFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) lastFocused = event.target;
    };
    menu.addEventListener("focusin", trackFocus);
    const contentObserver = new MutationObserver(() => {
      updatePosition();
      if (document.activeElement === menu ||
        (document.activeElement === document.body && lastFocused && !lastFocused.isConnected)) {
        focusSelection(menu);
      }
    });
    contentObserver.observe(menu, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      contentObserver.disconnect();
      menu.removeEventListener("focusin", trackFocus);
    };
  }, [open, props.disabled, props.align, focusSelection]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !positioned || props.disabled || !menu) return;
    focusSelection(menu);
  }, [open, positioned, props.disabled, focusSelection]);

  useEffect(() => {
    if (!open) return;
    function containsTarget(target: EventTarget | null) {
      if (!(target instanceof Node)) return false;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return true;
      // Nested menus render in portals but still belong to their parent popover.
      const element = target instanceof Element ? target : target.parentElement;
      return element?.closest<HTMLElement>("[data-settings-path]")?.dataset.settingsPath?.split(" ").includes(menuId);
    }
    function outsidePointer(event: PointerEvent) {
      if (!containsTarget(event.target)) dismiss(false);
    }
    function outsideFocus(event: FocusEvent) {
      if (!containsTarget(event.target)) dismiss(false);
    }
    function outsideScroll(event: Event) {
      if (containsTarget(event.target)) return;
      dismiss(false);
    }
    const onResize = () => dismiss(false);
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("focusin", outsideFocus, true);
    document.addEventListener("scroll", outsideScroll, true);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", outsideFocus, true);
      document.removeEventListener("scroll", outsideScroll, true);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
    };
  }, [open, dismiss, menuId]);

  function triggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      initialFocus.current = event.key === "ArrowUp" ? "last" : "selected";
      setOpen(true);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  }

  function menuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      if (role === "dialog") {
        const controls = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []);
        const boundary = event.shiftKey ? controls[0] : controls.at(-1);
        if (document.activeElement !== boundary) return;
      }
      // Continue the page's tab sequence from the trigger rather than the portal.
      dismiss(true);
      return;
    }
    if (role === "dialog") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = enabledItems(menu);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;
    focusItem(menu, items[index]);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`settings-trigger${props.className ? ` ${props.className}` : ""}`}
        aria-label={props.label}
        aria-description={props.title}
        aria-haspopup={role}
        aria-expanded={open && !props.disabled}
        aria-controls={open && !props.disabled ? menuId : undefined}
        data-settings-path={settingsPath.join(" ")}
        title={props.title}
        disabled={props.disabled}
        onKeyDown={triggerKeyDown}
        onClick={() => {
          initialFocus.current = "selected";
          if (open) dismiss(false);
          else setOpen(true);
        }}
      >
        {props.trigger}
      </button>
      {open && !props.disabled && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className={`settings-menu${props.contentClassName ? ` ${props.contentClassName}` : ""}`}
          role={role}
          aria-label={props.label}
          data-settings-path={settingsPath.join(" ")}
          tabIndex={-1}
          onKeyDown={menuKeyDown}
          style={{
            position: "fixed",
            zIndex: 100,
            top: position?.top || 0,
            left: position?.left || 0,
            width: position?.width ?? Math.min(320, window.innerWidth - 24),
            maxHeight: position?.maxHeight ?? window.innerHeight - 24,
            overflowY: "auto",
            visibility: position ? "visible" : "hidden",
          }}
        >
          <SettingsPath.Provider value={settingsPath}>{props.children(close)}</SettingsPath.Provider>
        </div>,
        document.body,
      )}
    </>
  );
}
