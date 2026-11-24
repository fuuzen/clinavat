import type { AgentPanelView, AgentProfile, Session, Turn } from "../src/types";
import type { DemoMessage } from "./store";

export interface DemoFixtureContext {
  ago: (minutes: number) => string;
  ids: {
    claudeSlot: string;
    claudeBackupSlot: string;
    codexSlot: string;
    webProject: string;
    apiProject: string;
  };
}

const orchIds = {
  hybridMaster: "00000000-0000-4000-8000-000000000410",
  hybridAudit: "00000000-0000-4000-8000-000000000411",
  hybridCouponUi: "00000000-0000-4000-8000-000000000412",
  superMaster: "00000000-0000-4000-8000-000000000420",
  superExplorer: "00000000-0000-4000-8000-000000000421",
  superCoder: "00000000-0000-4000-8000-000000000422",
  superVerifier: "00000000-0000-4000-8000-000000000423",
  superArchivedSql: "00000000-0000-4000-8000-000000000424",
  superArchivedSchema: "00000000-0000-4000-8000-000000000425",
  discussionReview: "00000000-0000-4000-8000-000000000501",
  discussionAudit: "00000000-0000-4000-8000-000000000502",
};

function msg(id: string, sessionId: string, role: string, content: string, createdAt: string, source?: DemoMessage["source"]): DemoMessage {
  return { id, session_id: sessionId, role, content, created_at: createdAt, ...(source ? { source } : {}) };
}

function turn(sessionId: string, userId: string, answerId: string, startedAt: string, completedAt: string, durationMs: number, items: Turn["items"]): Turn {
  return {
    id: userId, session_id: sessionId, user_message_id: userId, assistant_message_id: answerId,
    started_at: startedAt, completed_at: completedAt, duration_ms: durationMs, paused_at: null, paused_ms: 0,
    status: "completed", items, native_ref: answerId,
  };
}

export function createOrchestrationFixtures({ ago, ids }: DemoFixtureContext): {
  sessions: Session[];
  messages: DemoMessage[];
  turns: Turn[];
  agentPanels: Record<string, AgentPanelView>;
  projectMemories: Record<string, AgentPanelView["memories"]>;
  agentProfiles: AgentProfile[];
} {
  const agentProfiles: AgentProfile[] = [
    {
      id: "profile-explorer", name: "explorer", engine: "claude", slot_id: ids.claudeSlot,
      model: "claude-sonnet-5-5", reasoning_effort: "medium", access: "read",
      instructions: "只读梳理代码调用链、数据结构与边界条件，输出结构化发现。",
    },
    {
      id: "profile-coder", name: "coder", engine: "claude", slot_id: ids.claudeBackupSlot,
      model: "claude-opus-5-5", reasoning_effort: "high", access: "write",
      instructions: "在独立 worktree 中按任务契约完成代码实现与自检。",
    },
    {
      id: "profile-verifier", name: "verifier", engine: "codex", slot_id: ids.codexSlot,
      model: "gpt-5-codex", reasoning_effort: "high", access: "read",
      instructions: "独立审阅改动、排查并发与异常回归，给出验收结论。",
    },
  ];

  const sessions: Session[] = [
    {
      id: orchIds.hybridMaster, project_id: ids.webProject, engine: "claude", slot_mode: "auto", slot_id: ids.claudeSlot,
      title: "协作编排 · 结账页优惠券与库存校验", status: "idle", updated_at: ago(12),
      model: "claude-opus-5-5", reasoning_effort: "high", permission_mode: "accept-edits",
      agent_mode: "normal", role_preset: "default", native_session_id: "demo-native-hybrid",
      orchestration: 1, orchestration_mode: "hybrid",
    },
    {
      id: orchIds.hybridAudit, project_id: ids.webProject, engine: "codex", slot_mode: "manual", slot_id: ids.codexSlot,
      title: "排查库存扣减并发边界", status: "idle", updated_at: ago(16),
      model: "gpt-5-codex", reasoning_effort: "medium", permission_mode: "manual",
      agent_mode: "normal", role_preset: "reviewer", parent_session_id: orchIds.hybridMaster,
      agent_name: "inventory-audit", agent_access: "read", agent_isolation: "shared",
    },
    {
      id: orchIds.hybridCouponUi, project_id: ids.webProject, engine: "claude", slot_mode: "manual", slot_id: ids.claudeBackupSlot,
      title: "补充优惠券冲突提示与表单校验", status: "idle", updated_at: ago(14),
      model: "claude-sonnet-5-5", reasoning_effort: "medium", permission_mode: "accept-edits",
      agent_mode: "normal", role_preset: "default", parent_session_id: orchIds.hybridMaster,
      agent_name: "coupon-ui", agent_access: "write", agent_isolation: "worktree", agent_directory: "src/checkout",
    },
    {
      id: orchIds.superMaster, project_id: ids.apiProject, engine: "claude", slot_mode: "auto", slot_id: ids.claudeSlot,
      title: "Super Agent · 订单退款链路重构", status: "idle", updated_at: ago(6),
      model: "claude-opus-5-5", reasoning_effort: "high", permission_mode: "auto",
      agent_mode: "normal", role_preset: "default", native_session_id: "demo-native-super",
      orchestration: 1, orchestration_mode: "super",
    },
    {
      id: orchIds.superExplorer, project_id: ids.apiProject, engine: "claude", slot_mode: "manual", slot_id: ids.claudeSlot,
      title: "梳理现有退款入口与幂等键", status: "idle", updated_at: ago(22),
      model: "claude-sonnet-5-5", reasoning_effort: "medium", permission_mode: "auto",
      agent_mode: "normal", role_preset: "default", parent_session_id: orchIds.superMaster,
      agent_name: "explorer", agent_access: "read", agent_isolation: "shared", agent_directory: "src/routes",
    },
    {
      id: orchIds.superCoder, project_id: ids.apiProject, engine: "claude", slot_mode: "manual", slot_id: ids.claudeBackupSlot,
      title: "实现退款状态机与事务锁", status: "idle", updated_at: ago(11),
      model: "claude-opus-5-5", reasoning_effort: "high", permission_mode: "accept-edits",
      agent_mode: "normal", role_preset: "default", parent_session_id: orchIds.superMaster,
      agent_name: "refund-coder", agent_access: "write", agent_isolation: "worktree",
    },
    {
      id: orchIds.superVerifier, project_id: ids.apiProject, engine: "codex", slot_mode: "manual", slot_id: ids.codexSlot,
      title: "验收退款状态机与审计日志", status: "idle", updated_at: ago(8),
      model: "gpt-5-codex", reasoning_effort: "high", permission_mode: "auto",
      agent_mode: "normal", role_preset: "reviewer", parent_session_id: orchIds.superMaster,
      agent_name: "verifier", agent_access: "read", agent_isolation: "shared",
    },
    {
      id: orchIds.superArchivedSql, project_id: ids.apiProject, engine: "codex", slot_mode: "manual", slot_id: ids.codexSlot,
      title: "盘点历史退款 SQL 与索引现状", status: "idle", updated_at: ago(45), archived_at: ago(38),
      model: "gpt-5-codex", reasoning_effort: "medium", permission_mode: "auto",
      agent_mode: "normal", role_preset: "reviewer", parent_session_id: orchIds.superMaster,
      agent_name: "legacy-sql-scan", agent_access: "read", agent_isolation: "shared",
    },
    {
      id: orchIds.superArchivedSchema, project_id: ids.apiProject, engine: "claude", slot_mode: "manual", slot_id: ids.claudeSlot,
      title: "起草 refund_audit_logs 表结构方案", status: "idle", updated_at: ago(34), archived_at: ago(30),
      model: "claude-sonnet-5-5", reasoning_effort: "medium", permission_mode: "auto",
      agent_mode: "normal", role_preset: "default", parent_session_id: orchIds.superMaster,
      agent_name: "schema-draft", agent_access: "read", agent_isolation: "shared",
    },
  ];

  const hybridReportText = [
    '<clinavat_agent_report agent="inventory-audit" engine="codex" model="gpt-5-codex" status="completed" task="排查库存扣减并发边界">',
    "排查完成，发现 2 处并发边界需要防护：",
    "",
    "1. `src/checkout/submitOrder.ts:64` 仅在前端校验库存，两次快速点击会发出重复扣减请求；",
    "2. 建议在提交按钮增加 `idempotencyKey` 并在服务端 `UPDATE stock SET qty = qty - ? WHERE qty >= ?` 校验受影响行数。",
    "</clinavat_agent_report>",
    "",
    '<clinavat_agent_report agent="coupon-ui" engine="claude" model="claude-sonnet-5-5" status="completed" task="补充优惠券冲突提示与表单校验">',
    "已在独立 worktree（`agent/coupon-ui`）完成以下修改：",
    "",
    "- `src/checkout/CouponInput.tsx`：互斥券冲突时展示具体冲突原因，不再静默清空；",
    "- `src/checkout/CheckoutSummary.tsx`：实时展示折后金额与失效券提示；",
    "- `npm run typecheck` 通过。",
    "</clinavat_agent_report>",
  ].join("\n");

  const superReportText = [
    '<clinavat_agent_report agent="explorer" engine="claude" model="claude-sonnet-5-5" status="completed" task="梳理现有退款入口与幂等键">',
    "已梳理全部退款调用链：",
    "",
    "- 入口：`POST /api/orders/:id/refund`（`src/routes/orders.ts:118`）与定时补偿脚本 `src/jobs/refundRetry.ts`；",
    "- 现状：无显式状态机，`pending -> refunded` 之间缺少 `processing` 锁定态，重试时可能二次调用支付网关；",
    "- 建议采用 `(order_id, refund_request_id)` 唯一约束作为幂等键。",
    "</clinavat_agent_report>",
    "",
    '<clinavat_agent_report agent="refund-coder" engine="claude" model="claude-opus-5-5" status="completed" task="实现退款状态机与事务锁">',
    "已在独立 worktree（`agent/refund-state-machine`）完成重构：",
    "",
    "- 新增 `src/services/refundStateMachine.ts`，显式约束 `requested -> processing -> succeeded | failed` 状态流转；",
    "- 在事务内基于 `(order_id, idempotency_key)` 做条件更新与幂等返回；",
    "- 新增 `refund_audit_logs` 写入，记录操作者、原因、状态前后值与网关流水号。",
    "</clinavat_agent_report>",
  ].join("\n");

  const messages: DemoMessage[] = [
    // Hybrid master
    msg("m-h1", orchIds.hybridMaster, "user", "帮我给结账页加上优惠券叠加校验，同时让子智能体并行排查库存扣减的并发边界，最后汇总验证。", ago(20)),
    msg("m-h2", orchIds.hybridMaster, "assistant", [
      "已按**协作编排模式**拆解并并行推进：",
      "",
      "- **主智能体直接修改**：已在 `src/checkout/couponRules.ts` 中补齐满减券与折扣券的叠加互斥校验；",
      "- **子智能体 `@inventory-audit`（Codex 只读）**：并行排查库存扣减的并发边界；",
      "- **子智能体 `@coupon-ui`（Claude 独立 worktree）**：同步完善结账页冲突提示 UI。",
      "",
      "等待两位子智能体汇报后汇总验证。",
    ].join("\n"), ago(18)),
    msg("m-h3", orchIds.hybridMaster, "user", hybridReportText, ago(14), "report"),
    msg("m-h4", orchIds.hybridMaster, "assistant", [
      "已收到 `@inventory-audit` 与 `@coupon-ui` 的汇报并完成联调检查：",
      "",
      "1. 已在 `src/checkout/submitOrder.ts` 补上提交幂等键与防抖锁；",
      "2. `@coupon-ui` 的改动已在分支 `agent/coupon-ui` 就绪，可直接在下方子智能体面板点击 **合并**；",
      "3. `npm run typecheck` 通过。",
    ].join("\n"), ago(12)),

    // Hybrid children
    msg("m-ha1", orchIds.hybridAudit, "user", "请只读排查 `src/checkout/` 与订单提交接口中库存扣减的并发边界与重复提交风险。", ago(19), "delegation"),
    msg("m-ha2", orchIds.hybridAudit, "assistant", "发现 2 处并发边界：`submitOrder.ts:64` 缺少前端请求去重与幂等键；后端库存扣减需改为带 `WHERE qty >= ?` 条件的原子更新。已整理为结构化汇报回传主智能体。", ago(16)),
    msg("m-hc1", orchIds.hybridCouponUi, "user", "在 `src/checkout` 中接入 `couponRules.ts` 的冲突原因，完善优惠券输入框与结算汇总的错误提示。", ago(19), "delegation"),
    msg("m-hc2", orchIds.hybridCouponUi, "assistant", "已完成 `CouponInput.tsx` 和 `CheckoutSummary.tsx` 的冲突提示改造，并通过 `npm run typecheck`，改动已提交到 worktree 分支 `agent/coupon-ui`。", ago(14)),

    // Super Agent master
    msg("m-s1", orchIds.superMaster, "user", "把订单退款接口拆分成幂等状态机并补齐对账审计日志，按 Super Agent 模式统筹拆分任务、派发子智能体执行和验收。", ago(28)),
    msg("m-s2", orchIds.superMaster, "assistant", [
      "已进入 **Super Agent 只读统筹模式**，所有代码修改与命令执行均由子智能体分工完成：",
      "",
      "1. 已建立任务看板 `T1`–`T4`，并将状态机与幂等键约束写入持久记忆；",
      "2. 已派发只读 `@explorer` 梳理现有退款入口与补偿脚本（`T1`）；",
      "3. 待契约确认后由 `@refund-coder` 在独立 worktree 中实现状态机与审计日志（`T2`），再交由跨 CLI 的 Codex `@verifier` 独立验收（`T3`）。",
    ].join("\n"), ago(25)),
    msg("m-s3", orchIds.superMaster, "user", superReportText, ago(10), "report"),
    msg("m-s4", orchIds.superMaster, "assistant", [
      "已审阅 `@explorer` 与 `@refund-coder` 的交付物，并完成一次双引擎设计评审：",
      "",
      "- **架构契约**：已确认采用 `(order_id, idempotency_key)` 联合唯一键，防止重试穿透支付网关；",
      "- **当前进度**：`T1`、`T2` 已完成，`T3` 正由 Codex `@verifier` 处于待验收状态；",
      "- **下一步**：确认 `@verifier` 验收无回归后，即可在下方点击 **合并** `agent/refund-state-machine` 分支完成 `T4`。",
    ].join("\n"), ago(6)),

    // Super Agent children
    msg("m-se1", orchIds.superExplorer, "user", "只读排查 `src/routes` 和定时补偿任务中所有触发退款的入口，整理当前状态流转和幂等隐患。", ago(26), "delegation"),
    msg("m-se2", orchIds.superExplorer, "assistant", "已定位 `routes/orders.ts:118` 与 `jobs/refundRetry.ts` 两处入口，确认缺少 `processing` 中间锁定态，已将详细调用链汇报给 Super Agent。", ago(22)),
    msg("m-sc1", orchIds.superCoder, "user", "依据持久记忆中的 `refund-state-machine` 与 `idempotency-contract`，在独立 worktree 实现幂等退款状态机与 `refund_audit_logs` 审计表写入。", ago(20), "delegation"),
    msg("m-sc2", orchIds.superCoder, "assistant", "已在 `agent/refund-state-machine` 分支实现 `refundStateMachine.ts`、幂等事务锁及审计日志写入，并完成类型检查。", ago(11)),
    msg("m-sv1", orchIds.superVerifier, "user", "独立审阅 `agent/refund-state-machine` 分支改动，重点核查并发重复退款、网关超时回滚与审计日志完整性。", ago(10), "delegation"),
    msg("m-sv2", orchIds.superVerifier, "assistant", "已完成审阅：状态迁移守卫与唯一索引覆盖并发重试场景；建议在网关超时分支补充 `gateway_error_code` 字段以便财务对账，其余均符合验收标准。", ago(8)),
  ];

  const turns: Turn[] = [
    turn(orchIds.hybridMaster, "m-h1", "m-h2", ago(20), ago(18), 64_000, [
      { id: "ht-r1", kind: "reasoning", text: "协作编排模式下，主智能体直接改造规则核心模块，同时并行派发 Codex 做并发审计、派发 Claude worktree 改结账 UI。" },
      { id: "ht-1", kind: "tool", tool: { id: "ht-1", name: "Edit", input: { file_path: "src/checkout/couponRules.ts" }, output: "已更新叠加互斥规则", status: "completed" } },
      { id: "ht-2", kind: "tool", tool: { id: "ht-2", name: "start_agent", input: { name: "inventory-audit", engine: "codex", access: "read" }, output: "已启动子智能体 inventory-audit", status: "completed" } },
      { id: "ht-3", kind: "tool", tool: { id: "ht-3", name: "start_agent", input: { name: "coupon-ui", engine: "claude", isolation: "worktree", directory: "src/checkout" }, output: "已启动子智能体 coupon-ui", status: "completed" } },
    ]),
    turn(orchIds.hybridMaster, "m-h3", "m-h4", ago(14), ago(12), 42_000, [
      { id: "ht-4", kind: "tool", tool: { id: "ht-4", name: "Edit", input: { file_path: "src/checkout/submitOrder.ts" }, output: "已补充幂等键与防抖提交保护", status: "completed" } },
      { id: "ht-5", kind: "tool", tool: { id: "ht-5", name: "Bash", input: { command: "npm run typecheck" }, output: "> tsc -b\n✓ 0 errors\n", status: "completed" } },
    ]),
    turn(orchIds.hybridAudit, "m-ha1", "m-ha2", ago(19), ago(16), 38_000, [
      { id: "hat-1", kind: "tool", tool: { id: "hat-1", name: "shell", input: { command: "rg -n \"stock|inventory|submitOrder\" src/checkout" }, output: "src/checkout/submitOrder.ts:64: if (item.stock < item.qty) throw ...", status: "completed" } },
    ]),
    turn(orchIds.hybridCouponUi, "m-hc1", "m-hc2", ago(19), ago(14), 51_000, [
      { id: "hct-1", kind: "tool", tool: { id: "hct-1", name: "Edit", input: { file_path: "src/checkout/CouponInput.tsx" }, output: "已更新冲突提示 UI", status: "completed" } },
      { id: "hct-2", kind: "tool", tool: { id: "hct-2", name: "Bash", input: { command: "npm run typecheck" }, output: "> tsc -b\n✓ 0 errors\n", status: "completed" } },
    ]),
    turn(orchIds.superMaster, "m-s1", "m-s2", ago(28), ago(25), 55_000, [
      { id: "st-r1", kind: "reasoning", text: "Super Agent 模式保持只读统筹：先写持久记忆和任务看板，再按依赖分阶段派发 explorer、refund-coder 与 verifier。" },
      { id: "st-1", kind: "tool", tool: { id: "st-1", name: "memory_write", input: { key: "refund-state-machine" }, output: "已写入持久记忆 refund-state-machine", status: "completed" } },
      { id: "st-2", kind: "tool", tool: { id: "st-2", name: "task_create", input: { tasks: ["T1", "T2", "T3", "T4"] }, output: "已创建 4 项任务看板条目", status: "completed" } },
      { id: "st-3", kind: "tool", tool: { id: "st-3", name: "start_agent", input: { profile: "explorer", access: "read" }, output: "已派发子智能体 explorer", status: "completed" } },
    ]),
    turn(orchIds.superMaster, "m-s3", "m-s4", ago(10), ago(6), 49_000, [
      { id: "st-4", kind: "tool", tool: { id: "st-4", name: "start_agent", input: { profile: "verifier", engine: "codex", access: "read" }, output: "已派发 Codex verifier 验收 T3", status: "completed" } },
      { id: "st-5", kind: "tool", tool: { id: "st-5", name: "task_update", input: { code: "T3", status: "verifying" }, output: "T3 已更新为待验收", status: "completed" } },
    ]),
    turn(orchIds.superExplorer, "m-se1", "m-se2", ago(26), ago(22), 34_000, [
      { id: "set-1", kind: "tool", tool: { id: "set-1", name: "Grep", input: { pattern: "refund", path: "src" }, output: "src/routes/orders.ts:118\nsrc/jobs/refundRetry.ts:29", status: "completed" } },
    ]),
    turn(orchIds.superCoder, "m-sc1", "m-sc2", ago(20), ago(11), 92_000, [
      { id: "sct-1", kind: "tool", tool: { id: "sct-1", name: "Write", input: { file_path: "src/services/refundStateMachine.ts" }, output: "File created", status: "completed" } },
      { id: "sct-2", kind: "tool", tool: { id: "sct-2", name: "Bash", input: { command: "npm run typecheck" }, output: "> tsc -b\n✓ 0 errors\n", status: "completed" } },
    ]),
    turn(orchIds.superVerifier, "m-sv1", "m-sv2", ago(10), ago(8), 41_000, [
      { id: "svt-1", kind: "tool", tool: { id: "svt-1", name: "shell", input: { command: "git diff main...agent/refund-state-machine --stat" }, output: "src/services/refundStateMachine.ts | 142 +++\nsrc/routes/orders.ts | 38 ++-", status: "completed" } },
    ]),
  ];

  const agentPanels: Record<string, AgentPanelView> = {
    [orchIds.hybridMaster]: {
      agents: [
        {
          sessionId: orchIds.hybridAudit, name: "inventory-audit", engine: "codex", model: "GPT-5 Codex",
          slotId: ids.codexSlot, access: "read", status: "idle", archived: false, running: false,
          directory: null, isolation: "shared", worktree: null,
          lastTask: { status: "completed", finishedAt: ago(16) }, pendingReports: 0,
        },
        {
          sessionId: orchIds.hybridCouponUi, name: "coupon-ui", engine: "claude", model: "Sonnet 5.5",
          slotId: ids.claudeBackupSlot, access: "write", status: "idle", archived: false, running: false,
          directory: "src/checkout", isolation: "worktree",
          worktree: { branch: "agent/coupon-ui", state: "changes", conflicts: [] },
          lastTask: { status: "completed", finishedAt: ago(14) }, pendingReports: 0,
        },
      ],
      tasks: [
        {
          id: "htask-1", code: "T1", title: "补齐优惠券叠加互斥规则", description: "在 couponRules.ts 校验满减与折扣券冲突",
          acceptance: "冲突时返回结构化原因码", status: "completed", assignedAgent: null,
          dependsOn: [], summary: "主智能体已完成", updatedAt: ago(18),
        },
        {
          id: "htask-2", code: "T2", title: "排查库存扣减并发边界", description: "检查重复提交与超卖风险",
          acceptance: "定位所有非原子扣减路径", status: "completed", assignedAgent: "inventory-audit",
          dependsOn: [], summary: "已定位 2 处边界并修复", updatedAt: ago(16),
        },
        {
          id: "htask-3", code: "T3", title: "合并结账页冲突提示 worktree 分支", description: "审阅并合并 agent/coupon-ui 改动",
          acceptance: "合并无冲突且 typecheck 通过", status: "verifying", assignedAgent: "coupon-ui",
          dependsOn: ["T1"], summary: "分支改动已就绪，待合并", updatedAt: ago(12),
        },
      ],
      memories: [
        {
          key: "coupon-constraints",
          content: "1. 平台满减券与店铺折扣券不可叠加；\n2. 结账提交必须携带前端生成的 idempotencyKey。",
          updatedAt: ago(15),
        },
      ],
      discussions: [],
      pendingReports: 0,
      reportsPaused: false,
    },
    [orchIds.superMaster]: {
      agents: [
        {
          sessionId: orchIds.superExplorer, name: "explorer", engine: "claude", model: "Sonnet 5.5",
          slotId: ids.claudeSlot, access: "read", status: "idle", archived: false, running: false,
          directory: "src/routes", isolation: "shared", worktree: null,
          lastTask: { status: "completed", finishedAt: ago(22) }, pendingReports: 0,
        },
        {
          sessionId: orchIds.superCoder, name: "refund-coder", engine: "claude", model: "Opus 5.5",
          slotId: ids.claudeBackupSlot, access: "write", status: "idle", archived: false, running: false,
          directory: null, isolation: "worktree",
          worktree: { branch: "agent/refund-state-machine", state: "changes", conflicts: [] },
          lastTask: { status: "completed", finishedAt: ago(11) }, pendingReports: 0,
        },
        {
          sessionId: orchIds.superVerifier, name: "verifier", engine: "codex", model: "GPT-5 Codex",
          slotId: ids.codexSlot, access: "read", status: "idle", archived: false, running: false,
          directory: null, isolation: "shared", worktree: null,
          lastTask: { status: "completed", finishedAt: ago(8) }, pendingReports: 0,
        },
        {
          sessionId: orchIds.superArchivedSql, name: "legacy-sql-scan", engine: "codex", model: "GPT-5 Codex",
          slotId: ids.codexSlot, access: "read", status: "idle", archived: true, running: false,
          directory: "src/db", isolation: "shared", worktree: null,
          lastTask: { status: "completed", finishedAt: ago(42) }, pendingReports: 0,
        },
        {
          sessionId: orchIds.superArchivedSchema, name: "schema-draft", engine: "claude", model: "Sonnet 5.5",
          slotId: ids.claudeSlot, access: "read", status: "idle", archived: true, running: false,
          directory: "migrations", isolation: "shared", worktree: null,
          lastTask: { status: "completed", finishedAt: ago(32) }, pendingReports: 0,
        },
      ],
      tasks: [
        {
          id: "stask-1", code: "T1", title: "梳理现有退款入口与幂等隐患", description: "覆盖 API 路由与重试定时任务",
          acceptance: "产出完整入口清单", status: "completed", assignedAgent: "explorer",
          dependsOn: [], summary: "发现 2 处入口缺锁定态", updatedAt: ago(22),
        },
        {
          id: "stask-2", code: "T2", title: "实现幂等退款状态机与审计日志", description: "requested -> processing -> succeeded | failed",
          acceptance: "唯一键防重入 + 完整审计记录", status: "completed", assignedAgent: "refund-coder",
          dependsOn: ["T1"], summary: "已提交至独立 worktree", updatedAt: ago(11),
        },
        {
          id: "stask-3", code: "T3", title: "跨引擎独立审阅并发与回滚边界", description: "由 Codex verifier 独立验收改动",
          acceptance: "无并发双退与日志遗漏", status: "verifying", assignedAgent: "verifier",
          dependsOn: ["T2"], summary: "建议补 gateway_error_code", updatedAt: ago(8),
        },
        {
          id: "stask-4", code: "T4", title: "补齐财务对账导出字段映射", description: "在审计日志中附带 gateway_error_code 与渠道流水号",
          acceptance: "对账脚本解析无缺字段", status: "pending", assignedAgent: "refund-coder",
          dependsOn: ["T3"], summary: null, updatedAt: ago(7),
        },
        {
          id: "stask-5", code: "T5", title: "合并退款状态机分支并完成回归", description: "合并 agent/refund-state-machine 并清理 worktree",
          acceptance: "主分支构建与验收通过", status: "pending", assignedAgent: null,
          dependsOn: ["T3", "T4"], summary: null, updatedAt: ago(6),
        },
        {
          id: "stask-6", code: "T6", title: "更新接口文档与迁移说明", description: "补充新错误码与幂等请求头说明",
          acceptance: "docs/api.md 同步更新", status: "pending", assignedAgent: null,
          dependsOn: ["T5"], summary: null, updatedAt: ago(6),
        },
      ],
      memories: [],
      discussions: [
        {
          id: orchIds.discussionReview,
          topic: "退款状态机幂等键设计评审",
          format: "review",
          status: "completed",
          detail: "双引擎达成一致：采用联合唯一键 + processing 事务锁",
          round: 1,
          rounds: 1,
          startedBy: "master",
          participants: [
            { sessionId: orchIds.superExplorer, name: "explorer", engine: "claude", model: "Sonnet 5.5", stance: "实现视角", running: false, statements: [{ round: 1, status: "completed" }] },
            { sessionId: orchIds.superVerifier, name: "verifier", engine: "codex", model: "GPT-5 Codex", stance: "审阅视角", running: false, statements: [{ round: 1, status: "completed" }] },
          ],
        },
        {
          id: orchIds.discussionAudit,
          topic: "财务审计日志保留策略与脱敏规范",
          format: "council",
          status: "completed",
          detail: "保留脱敏后的支付渠道流水号与错误码，不落库原始卡号与回调签名",
          round: 1,
          rounds: 1,
          startedBy: "master",
          participants: [
            { sessionId: orchIds.superCoder, name: "refund-coder", engine: "claude", model: "Opus 5.5", stance: "落库成本", running: false, statements: [{ round: 1, status: "completed" }] },
            { sessionId: orchIds.superVerifier, name: "verifier", engine: "codex", model: "GPT-5 Codex", stance: "合规审计", running: false, statements: [{ round: 1, status: "completed" }] },
          ],
        },
      ],
      pendingReports: 0,
      reportsPaused: false,
    },
  };

  const projectMemories: Record<string, AgentPanelView["memories"]> = {
    [ids.apiProject]: [
      {
        key: "refund-state-machine",
        content: "允许流转：requested -> processing -> succeeded | failed。\n仅 requested / failed 可重新进入 processing，且必须在同一数据库事务内完成条件更新与锁校验。",
        updatedAt: ago(24),
      },
      {
        key: "idempotency-contract",
        content: "统一使用 (order_id, idempotency_key) 联合唯一约束；重复请求直接返回已有退款单号与当前状态，严禁二次调用支付网关。",
        updatedAt: ago(12),
      },
      {
        key: "audit-log-schema",
        content: "refund_audit_logs 表记录 order_id、refund_id、operator_id、from_status、to_status、gateway_tx_id、gateway_error_code 与 created_at。\n不保存原始银行卡号或第三方回调签名密钥。",
        updatedAt: ago(30),
      },
      {
        key: "error-handling-convention",
        content: "路由层禁止空的 catch {} 吞掉数据库异常；上游不可用统一抛出 HttpError(503) 并写入结构化 requestId 日志。",
        updatedAt: ago(180),
      },
      {
        key: "retry-backoff-policy",
        content: "定时补偿任务 src/jobs/refundRetry.ts 采用指数退避（1m / 5m / 15m / 1h），单笔最多重试 4 次，超过后标记需人工介入。",
        updatedAt: ago(95),
      },
      {
        key: "payment-gateway-timeout",
        content: "调用支付网关超时阈值固定为 8 秒；超时不代表失败，必须保持 processing 状态并交由查询接口核验最终态。",
        updatedAt: ago(60),
      },
      {
        key: "db-migration-rule",
        content: "所有表结构变更均通过 migrations/ 增量脚本管理，上线前需验证对存量 orders 与 refunds 表无锁表风险。",
        updatedAt: ago(240),
      },
      {
        key: "local-verification",
        content: "提交改动前需通过 npm run typecheck，且不得在源码中硬编码本地数据库连接串或测试密钥。",
        updatedAt: ago(140),
      },
    ],
    [ids.webProject]: [
      {
        key: "coupon-constraints",
        content: "1. 平台满减券与店铺折扣券不可叠加；\n2. 结账提交必须携带前端生成的 idempotencyKey，防止连续点击触发重复下单。",
        updatedAt: ago(15),
      },
      {
        key: "cart-state-architecture",
        content: "购物车全局状态统一收拢在 src/cart/useCart.ts reducer 中，CartPage、MiniCart 与 CheckoutSummary 仅通过 hook 读写。",
        updatedAt: ago(38),
      },
      {
        key: "checkout-ui-a11y",
        content: "优惠券冲突与库存不足提示必须绑定 aria-live=\"polite\"，并在错误态保留用户已输入券码以便修改。",
        updatedAt: ago(20),
      },
      {
        key: "design-tokens",
        content: "前端样式一律使用主题 CSS 变量（--panel / --surface / --accent / --line），禁止写死深色或浅色 hex 色值。",
        updatedAt: ago(120),
      },
    ],
  };

  return { sessions, messages, turns, agentPanels, projectMemories, agentProfiles };
}
