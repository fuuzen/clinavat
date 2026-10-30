import { CircleAlert, LoaderCircle } from "lucide-react";
import type { SlotUsage } from "../../types";
import { slotUsageRings } from "./slot-usage-rings";
import "../../styles/slot-usage-ring.css";

interface Props {
  engine: "claude" | "codex";
  usage?: SlotUsage;
  now: number;
  slotLimited?: boolean;
  saving?: boolean;
}

export default function SlotUsageRing({ engine, usage, now, slotLimited, saving }: Props) {
  const { rings, limited, description } = slotUsageRings(engine, usage, now, slotLimited);
  const label = `${engine === "claude" ? "Claude Code" : "Codex"}；${description}`;
  return (
    <span className="slot-usage-ring" role="img" aria-label={label} title={label}>
      <svg className="slot-usage-ring-chart" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
        {rings.map(({ position, used, level }) => {
          const radius = position === "outer" ? 14.5 : 11;
          return <g key={position} className={`slot-usage-ring-${position} slot-usage-ring-${level}`}>
            <circle className={`slot-usage-ring-track${used === null ? " slot-usage-ring-unknown" : ""}`}
              cx="16" cy="16" r={radius} />
            {used !== null && used > 0 && <circle className="slot-usage-ring-value"
              cx="16" cy="16" r={radius} pathLength="100"
              strokeDasharray={`${Math.min(100, used)} 100`} transform="rotate(-90 16 16)" />}
          </g>;
        })}
      </svg>
      <span className={`slot-usage-ring-brand engine-symbol engine-${engine}`} aria-hidden="true">
        {saving ? <LoaderCircle size={16} className="spin" /> : <span className={`engine-logo engine-logo-${engine}`} />}
      </span>
      {limited && <CircleAlert className="slot-usage-ring-limited" size={11} aria-hidden="true" />}
    </span>
  );
}
