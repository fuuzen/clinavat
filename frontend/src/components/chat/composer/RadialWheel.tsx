import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";

export type ControlModuleId = "permission" | "behavior" | "question";

export interface RadialSector {
  id: ControlModuleId;
  title: string;
  value: string;
  hint?: string;
  icon: ReactNode;
  disabled?: boolean;
  /** CSS class applied to the sector (e.g. permission color class or active highlight). */
  className?: string;
  /** Accent color CSS variable or expression for the sector's rim and indicator. */
  accent?: string;
}

interface Props {
  sectors: [RadialSector, RadialSector, RadialSector];
  onSelect: (id: ControlModuleId) => void;
  onClose: () => void;
}

const size = 276;
const cx = size / 2;
const cy = size / 2;
const innerR = 45;
const outerR = 122;
const labelR = 81;
const popDistance = 4.5;

// Top (12 o'clock), Bottom-Left (8 o'clock), Bottom-Right (4 o'clock).
const geometry = [
  { centerDeg: -90, startDeg: -147, endDeg: -33, labelDy: 0 },
  { centerDeg: 150, startDeg: 93, endDeg: 207, labelDy: -3 },
  { centerDeg: 30, startDeg: -27, endDeg: 87, labelDy: -3 },
] as const;

const ticks = Array.from({ length: 12 }, (_, index) => index * 30);

function polar(radius: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function sectorPath(startDeg: number, endDeg: number): string {
  const p1 = polar(outerR, startDeg);
  const p2 = polar(outerR, endDeg);
  const p3 = polar(innerR, endDeg);
  const p4 = polar(innerR, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function rimArcPath(startDeg: number, endDeg: number): string {
  const p1 = polar(outerR - 1, startDeg + 4);
  const p2 = polar(outerR - 1, endDeg - 4);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${outerR - 1} ${outerR - 1} 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

export default function RadialWheel({ sectors, onSelect, onClose }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const wheelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    wheelRef.current?.focus({ preventScroll: true });
  }, []);

  const activeSector = activeIndex !== null ? sectors[activeIndex] : null;
  const activeGeo = activeIndex !== null ? geometry[activeIndex] : null;

  function stepActive(delta: number) {
    const current = activeIndex ?? -1;
    for (let offset = 1; offset <= sectors.length; offset++) {
      const next = (current + delta * offset + sectors.length * 2) % sectors.length;
      if (!sectors[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!sectors[0].disabled) setActiveIndex(0);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (!sectors[1].disabled) setActiveIndex(1);
      else stepActive(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (!sectors[2].disabled) setActiveIndex(2);
      else stepActive(1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepActive(1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && activeIndex !== null) {
      event.preventDefault();
      const target = sectors[activeIndex];
      if (!target.disabled) onSelect(target.id);
    }
  }

  return (
    <div
      ref={wheelRef}
      className="radial-wheel"
      role="menu"
      aria-label="对话控制转盘"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg className="radial-wheel-svg" viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="radial-bezel" cx={cx} cy={cy} r={outerR + 10} />
        <g className="radial-ticks">
          {ticks.map((deg) => {
            const p1 = polar(outerR + 6, deg);
            const p2 = polar(outerR + (deg % 90 === 0 ? 11 : 9), deg);
            return <line key={deg} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} />;
          })}
        </g>

        {sectors.map((sector, index) => {
          const geo = geometry[index];
          const isActive = activeIndex === index;
          const rad = (geo.centerDeg * Math.PI) / 180;
          const tx = isActive && !sector.disabled ? Math.cos(rad) * popDistance : 0;
          const ty = isActive && !sector.disabled ? Math.sin(rad) * popDistance : 0;
          const style = {
            "--sector-accent": sector.accent || "var(--accent)",
            transform: `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`,
          } as CSSProperties;
          return (
            <g
              key={sector.id}
              className={`radial-sector-group${sector.className ? ` ${sector.className}` : ""}${isActive ? " is-active" : ""}${sector.disabled ? " is-disabled" : ""}`}
              style={style}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => { if (!sector.disabled) onSelect(sector.id); }}
            >
              <path
                className="radial-sector-shape"
                d={sectorPath(geo.startDeg, geo.endDeg)}
                role="menuitem"
                aria-label={`${sector.title}：${sector.value}${sector.disabled && sector.hint ? `（${sector.hint}）` : ""}`}
                aria-disabled={sector.disabled || undefined}
              />
              <path className="radial-sector-rim" d={rimArcPath(geo.startDeg, geo.endDeg)} />
            </g>
          );
        })}

        {activeGeo && activeSector && !activeSector.disabled && (
          <g
            className={`radial-pointer${activeSector.className ? ` ${activeSector.className}` : ""}`}
            style={{ "--sector-accent": activeSector.accent || "var(--accent)" } as CSSProperties}
            transform={`rotate(${activeGeo.centerDeg} ${cx} ${cy})`}
          >
            <polygon points={`${cx + innerR - 2},${cy} ${cx + innerR - 8},${cy - 4} ${cx + innerR - 8},${cy + 4}`} />
          </g>
        )}
      </svg>

      {sectors.map((sector, index) => {
        const geo = geometry[index];
        const isActive = activeIndex === index;
        const pos = polar(labelR, geo.centerDeg);
        const rad = (geo.centerDeg * Math.PI) / 180;
        const tx = isActive && !sector.disabled ? Math.cos(rad) * popDistance : 0;
        const ty = isActive && !sector.disabled ? Math.sin(rad) * popDistance : 0;
        return (
          <div
            key={sector.id}
            className={`radial-sector-label${sector.className ? ` ${sector.className}` : ""}${isActive ? " is-active" : ""}${sector.disabled ? " is-disabled" : ""}`}
            style={{
              left: `${(pos.x / size) * 100}%`,
              top: `${((pos.y + geo.labelDy) / size) * 100}%`,
              transform: `translate(-50%, -50%) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`,
              "--sector-accent": sector.accent || "var(--accent)",
            } as CSSProperties}
            aria-hidden="true"
          >
            <span className="radial-sector-icon">{sector.icon}</span>
            <strong className="radial-sector-title">{sector.title}</strong>
            <span className="radial-sector-value">{sector.disabled && sector.hint ? sector.hint : sector.value}</span>
          </div>
        );
      })}

      <button
        type="button"
        className={`radial-hub${activeSector?.className ? ` ${activeSector.className}` : ""}`}
        style={{ "--sector-accent": activeSector?.accent || "var(--accent)" } as CSSProperties}
        onClick={onClose}
        aria-label="关闭控制转盘"
        title="关闭控制转盘"
      >
        {activeSector ? (
          <>
            <span className="radial-hub-icon">{activeSector.icon}</span>
            <span className="radial-hub-caption">{activeSector.disabled ? "暂不可调" : "点击配置"}</span>
          </>
        ) : (
          <>
            <span className="radial-hub-icon radial-hub-idle"><SlidersHorizontal size={16} aria-hidden="true" /></span>
            <span className="radial-hub-close"><X size={16} aria-hidden="true" /></span>
            <span className="radial-hub-caption">控制盘</span>
          </>
        )}
      </button>
    </div>
  );
}
