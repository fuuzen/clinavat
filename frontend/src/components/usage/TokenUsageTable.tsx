import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { TokenUsageRow } from "../../types";
import { formatCost, formatTokens, formatUsedAt, sumUsage } from "./token-usage";

export interface UsageGroup {
  key: string;
  label: string;
  detail: string;
  rows: TokenUsageRow[];
}

function UsageCells({ rows }: { rows: TokenUsageRow[] }) {
  const totals = sumUsage(rows);
  return (
    <>
      <td>{formatTokens(totals.input)}</td>
      <td className="token-usage-secondary">{formatTokens(totals.cacheRead)}</td>
      <td className="token-usage-secondary">{formatTokens(totals.cacheWrite)}</td>
      <td>{formatTokens(totals.output)}</td>
      <td><strong>{formatTokens(totals.total)}</strong></td>
      <td title={totals.unpriced ? `${totals.unpriced} 条记录的模型没有价格，未计入费用` : undefined}>{formatCost(totals)}</td>
      <td className="token-usage-secondary">{formatUsedAt(totals.lastUsedAt)}</td>
    </>
  );
}

/** One row per group with its totals; expanding a group lists its models. */
export default function TokenUsageTable({ groups, heading }: { groups: UsageGroup[]; heading: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }
  return (
    <div className="token-usage-scroll">
      <table className="token-usage-table">
        <thead>
          <tr>
            <th>{heading}</th><th>输入</th><th className="token-usage-secondary">缓存读取</th>
            <th className="token-usage-secondary">缓存写入</th><th>输出</th><th>合计</th><th>费用</th>
            <th className="token-usage-secondary">最近使用</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const open = expanded.has(group.key);
            return (
              <Fragment key={group.key}>
                <tr className="token-usage-group">
                  <td>
                    <button type="button" aria-expanded={open} onClick={() => toggle(group.key)}>
                      <ChevronRight size={13} className={open ? "open" : ""} aria-hidden="true" />
                      <span><strong>{group.label}</strong><small>{group.detail}</small></span>
                    </button>
                  </td>
                  <UsageCells rows={group.rows} />
                </tr>
                {open && group.rows.map((row) => (
                  <tr className="token-usage-model" key={`${group.key}:${row.engine}:${row.model}`}>
                    <td>{row.model}{row.reasoning_tokens > 0 && <small>推理 {formatTokens(row.reasoning_tokens)}</small>}</td>
                    <UsageCells rows={[row]} />
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
