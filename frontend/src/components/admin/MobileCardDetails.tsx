import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import "../../styles/admin-mobile-cards.css";

interface Props {
  children: ReactNode;
  summary?: ReactNode;
  label: string;
  className?: string;
}

export default function MobileCardDetails({ children, summary, label, className = "" }: Props) {
  const contentId = useId();
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const resize = () => setCompact(query.matches);
    query.addEventListener("change", resize);
    resize();
    return () => query.removeEventListener("change", resize);
  }, []);
  return (
    <div className={`admin-mobile-details ${className}`}>
      {compact && (
        <div className="admin-mobile-details-summary">
          {summary && <div>{summary}</div>}
          <button type="button" className="admin-mobile-details-toggle" aria-expanded={expanded}
            aria-controls={contentId} aria-label={`${expanded ? "收起" : "展开"}${label}详情`}
            onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起详情" : "展开详情"}<ChevronDown size={14} />
          </button>
        </div>
      )}
      <div id={contentId} className="admin-mobile-details-content" hidden={compact && !expanded}>
        {children}
      </div>
    </div>
  );
}
