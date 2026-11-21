import { CircleAlert, LoaderCircle } from "lucide-react";
import type { SlotUsage } from "../../types";
import { engineLabel, type AgentEngine } from "../../engines";
import { slotUsageRings } from "./slot-usage-rings";
import "../../styles/slot-usage-ring.css";

interface Props {
  engine: AgentEngine;
  usage?: SlotUsage;
  now: number;
  slotLimited?: boolean;
  saving?: boolean;
  /** Draw only the engine mark, for places that show usage another way. */
  plain?: boolean;
}

export default function SlotUsageRing({ engine, usage, now, slotLimited, saving, plain }: Props) {
  const { rings, limited, description } = slotUsageRings(engine, usage, now, slotLimited);
  const label = `${engineLabel(engine)}；${description}`;
  // A third, per-model window needs the rings drawn closer together around a smaller mark.
  const three = !plain && rings.some((item) => item.position === "core");
  const radii = three ? { outer: 15, inner: 12.4, core: 9.8 } : { outer: 14.5, inner: 11, core: 0 };
  return (
    <span className={`slot-usage-ring${three ? " slot-usage-ring-three" : ""}`} role="img" aria-label={label} title={label}>
      {!plain && <svg className="slot-usage-ring-chart" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
        {rings.map(({ position, used, stale, level }) => {
          const radius = radii[position];
          return <g key={position} className={`slot-usage-ring-${position} slot-usage-ring-${level}${stale ? " slot-usage-ring-stale" : ""}`}>
            <circle className={`slot-usage-ring-track${used === null ? " slot-usage-ring-unknown" : ""}`}
              cx="16" cy="16" r={radius} />
            {used !== null && used > 0 && <circle className="slot-usage-ring-value"
              cx="16" cy="16" r={radius} pathLength="100"
              strokeDasharray={`${Math.min(100, used)} 100`} transform="rotate(-90 16 16)" />}
          </g>;
        })}
      </svg>}
      <span className={`slot-usage-ring-brand engine-symbol engine-${engine}`} aria-hidden="true">
        {saving ? <LoaderCircle size={16} className="spin" /> : <span className={`engine-logo engine-logo-${engine}`} />}
      </span>
      {limited && <CircleAlert className="slot-usage-ring-limited" size={11} aria-hidden="true" />}
    </span>
  );
}
