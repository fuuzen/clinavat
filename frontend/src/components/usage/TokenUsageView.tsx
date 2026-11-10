import { useEffect, useMemo, useState } from "react";
import { BarChart3, LoaderCircle, RefreshCw } from "lucide-react";
import { api, errorText } from "../../api";
import type { TokenUsageReport, TokenUsageRow } from "../../types";
import TokenUsageTable, { type UsageGroup } from "./TokenUsageTable";
import { formatCost, formatTokens, sumUsage, usagePeriods } from "./token-usage";
import "../../styles/token-usage.css";

interface Props {
  /** `/token-usage` for the signed-in user, `/admin/token-usage` for everyone. */
  path: string;
  heading: string;
  groupOf: (row: TokenUsageRow) => Omit<UsageGroup, "rows">;
  emptyText: string;
}

export default function TokenUsageView({ path, heading, groupOf, emptyText }: Props) {
  const [days, setDays] = useState(30);
  const [version, setVersion] = useState(0);
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<TokenUsageReport>(`${path}?days=${days}`, { signal: controller.signal })
      .then(setReport)
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, days, version]);
  const groups = useMemo(() => {
    const grouped = new Map<string, UsageGroup>();
    for (const row of report?.rows ?? []) {
      const group = groupOf(row);
      const existing = grouped.get(group.key);
      if (existing) existing.rows.push(row);
      else grouped.set(group.key, { ...group, rows: [row] });
    }
    return [...grouped.values()];
  }, [report, groupOf]);
  const totals = sumUsage(report?.rows ?? []);
  return (
    <div className="token-usage" aria-busy={loading}>
      <div className="token-usage-toolbar">
        <div className="token-usage-summary">
          <span><small>Token 合计</small><strong>{formatTokens(totals.total)}</strong></span>
          <span><small>按 API 价折算</small><strong>{formatCost(totals)}</strong></span>
        </div>
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="统计时间范围">
          {usagePeriods.map((period) => <option key={period.days} value={period.days}>{period.label}</option>)}
        </select>
        <button type="button" className="icon-button" disabled={loading} onClick={() => setVersion((value) => value + 1)}
          aria-label="刷新用量" title="刷新用量">
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {!report && loading ? <div className="loading-state"><LoaderCircle size={20} className="spin" /></div>
        : groups.length ? <TokenUsageTable groups={groups} heading={heading} />
          : !error && <div className="settings-empty"><BarChart3 size={29} /><p>{emptyText}</p></div>}
      <p className="token-usage-note">
        数据来自官方 CLI 在对话中报告的 Token 用量，从启用统计后开始记录。Claude 的金额由 CLI 自行估算，Codex 按
        {report ? ` ${report.priceSnapshotDate} ` : "内置"}的模型价格快照折算。订阅账号的金额只是按 API 标价折算的等价值，并非实际扣费；
        带 + 的金额不含价格未知的模型。展开一行可查看各模型的明细。
      </p>
    </div>
  );
}
