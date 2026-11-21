import { BarChart3 } from "lucide-react";
import type { TokenUsageRow } from "../../types";
import TokenUsageView from "../usage/TokenUsageView";
import { engineLabel } from "../../engines";

const bySlot = (row: TokenUsageRow) => ({ key: row.slot_id, label: row.slot_label ?? row.slot_id, detail: engineLabel(row.engine) });

/** The signed-in user's own usage, per slot they used. */
export default function TokenUsageSettings() {
  return (
    <>
      <div className="settings-section-heading">
        <BarChart3 size={17} />
        <h3>我的用量</h3>
      </div>
      <p className="settings-description">你在各个账号槽位上的 Token 用量，只包含你自己的对话。</p>
      <TokenUsageView path="/token-usage" heading="槽位" groupOf={bySlot} emptyText="所选时间范围内还没有用量记录。" />
    </>
  );
}
