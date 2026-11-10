import { BarChart3 } from "lucide-react";
import type { TokenUsageRow } from "../../types";
import TokenUsageView from "../usage/TokenUsageView";
import { engineLabel } from "../usage/token-usage";

const byUserAndSlot = (row: TokenUsageRow) => ({
  key: `${row.user_id}:${row.slot_id}`, label: row.username ?? row.user_id,
  detail: `${row.slot_label ?? row.slot_id} · ${engineLabel(row.engine)}`,
});

/** Every user's usage per slot, including slots that the user can no longer use. */
export default function TokenUsageReport() {
  return (
    <section className="admin-card">
      <div className="admin-card-heading"><div><BarChart3 size={17} /><h3>用量统计</h3></div></div>
      <TokenUsageView path="/admin/token-usage" heading="用户 / 槽位" groupOf={byUserAndSlot} emptyText="所选时间范围内还没有用量记录。" />
    </section>
  );
}
