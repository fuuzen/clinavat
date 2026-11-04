import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const SHOW_FOR = 4000;
const GUTTER = 12;

interface Props {
  text: string;
  /** Reachable by arrow keys; leave off when the same text is already on the option it explains. */
  menuItem?: boolean;
}

// The label is the help text: hover or focus shows it, and a tap keeps it up briefly for touch screens.
// The tooltip lives outside the menu so it is never clipped by, or adds height to, the scrolling menu.
export default function SettingsHelp({ text, menuItem = false }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const shown = hovered || tapped;

  useEffect(() => {
    if (!tapped) return;
    const timer = window.setTimeout(() => setTapped(false), SHOW_FOR);
    return () => window.clearTimeout(timer);
  }, [tapped]);

  useEffect(() => {
    const button = buttonRef.current;
    if (!shown || !button) {
      setStyle(null);
      return;
    }
    const box = button.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    setStyle({
      right: Math.max(GUTTER, window.innerWidth - box.right),
      maxWidth: Math.min(260, box.right - GUTTER),
      ...(below >= 140 || below >= box.top ? { top: box.bottom + 4 } : { bottom: window.innerHeight - box.top + 4 }),
    });
    const hide = () => { setHovered(false); setTapped(false); };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [shown]);

  return (
    <>
      <button ref={buttonRef} type="button" className="icon-button settings-menu-help"
        role={menuItem ? "menuitem" : undefined} tabIndex={-1} aria-hidden={menuItem ? undefined : true}
        aria-label={text} data-shown={shown || undefined}
        // A hidden button must not take focus away from the option it explains.
        onMouseDown={(event) => { if (!menuItem) event.preventDefault(); }}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setHovered(false); }}
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setHovered(true); }}
        onBlur={() => setHovered(false)}
        onClick={() => setTapped(!tapped)}>
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {style && createPortal(<div className="settings-help-tooltip" aria-hidden="true" style={style}>{text}</div>, document.body)}
    </>
  );
}
