import type { DevHost, Project, Session, Slot, Turn, User } from "../src/types";
import type { DemoMessage } from "./store";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  member: "00000000-0000-4000-8000-000000000002",
  claudeSlot: "00000000-0000-4000-8000-000000000101",
  codexSlot: "00000000-0000-4000-8000-000000000102",
  localHost: "00000000-0000-4000-8000-000000000201",
  remoteHost: "00000000-0000-4000-8000-000000000202",
  webProject: "00000000-0000-4000-8000-000000000301",
  apiProject: "00000000-0000-4000-8000-000000000302",
  refactorSession: "00000000-0000-4000-8000-000000000401",
  reviewSession: "00000000-0000-4000-8000-000000000402",
};

const demoKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoOnlyPublicKeyForPreview clinavat-demo";

function slot(id: string, label: string, engine: Slot["engine"]): Slot {
  return {
    id, label, engine, status: "IDLE", allowed_user_ids: [], max_concurrent_users: 1,
    in_use: false, in_use_by_you: false, active_user_id: null,
    home_dir: `/data/slots/${engine}-1`, credential_revision: 1, updated_at: ago(600),
  };
}

function session(id: string, projectId: string, engine: Session["engine"], slotId: string, title: string, minutes: number): Session {
  return {
    id, project_id: projectId, engine, slot_id: slotId, title, status: "idle", updated_at: ago(minutes),
    model: null, reasoning_effort: null, permission_mode: "manual", agent_mode: "normal", role_preset: "default",
  };
}

function message(id: string, sessionId: string, role: string, content: string, minutes: number): DemoMessage {
  return { id, session_id: sessionId, role, content, created_at: ago(minutes) };
}

function historyTurn(sessionId: string, userMessageId: string, answerId: string, minutes: number, items: Turn["items"]): Turn {
  return {
    id: userMessageId, session_id: sessionId, user_message_id: userMessageId, assistant_message_id: answerId,
    started_at: ago(minutes), completed_at: ago(minutes - 1), duration_ms: 48_000, paused_at: null, paused_ms: 0,
    status: "completed", items,
  };
}

export function createFixtures() {
  const user: User = { id: ids.admin, username: "demo", role: "admin", created_at: ago(60 * 24 * 30), ssh_public_key: demoKey };
  const users: User[] = [user, { id: ids.member, username: "teammate", role: "user", created_at: ago(60 * 24 * 7) }];
  const slots = [slot(ids.claudeSlot, "Claude 账号 A", "claude"), slot(ids.codexSlot, "Codex 账号 A", "codex")];
  const hosts: DevHost[] = [
    { id: ids.localHost, kind: "local", name: "本机", host: "localhost", port: 22, username: "clinavat", status: "LOCAL" },
    {
      id: ids.remoteHost, kind: "ssh", name: "开发服务器", host: "dev.example.com", port: 22, username: "developer",
      status: "CONNECTED", fingerprint: "SHA256:demo+fingerprint+for+preview",
    },
  ];
  const projects: Project[] = [
    {
      id: ids.webProject, name: "storefront-web", dev_host_id: ids.remoteHost, remote_path: "/home/developer/storefront-web",
      local_path: "/data/mirrors/storefront-web", path_mode: "auto", execution_mode: "direct", sync_status: "WATCHING",
    },
    {
      id: ids.apiProject, name: "orders-api", dev_host_id: ids.localHost, remote_path: "/srv/orders-api",
      local_path: "/srv/orders-api", path_mode: "auto", execution_mode: "local", sync_status: "LOCAL",
    },
  ];
  const sessions = [
    session(ids.refactorSession, ids.webProject, "claude", ids.claudeSlot, "重构购物车状态管理", 35),
    session(ids.reviewSession, ids.apiProject, "codex", ids.codexSlot, "审查订单接口的错误处理", 180),
  ];
  const messages: DemoMessage[] = [
    message("m-1", ids.refactorSession, "user", "购物车状态散落在多个组件里，帮我收拢到一个 hook 中，并保持现有行为不变。", 40),
    message("m-2", ids.refactorSession, "assistant", [
      "已将购物车状态收拢到 `src/cart/useCart.ts`：",
      "",
      "- `CartPage`、`MiniCart`、`CheckoutSummary` 改为通过 `useCart()` 读取和修改状态；",
      "- 数量变更与优惠券计算集中在 reducer 中，便于测试；",
      "- `npm run typecheck` 通过，页面行为与之前一致。",
    ].join("\n"), 38),
    message("m-3", ids.reviewSession, "user", "检查 orders 路由里有没有吞掉异常的地方。", 185),
    message("m-4", ids.reviewSession, "assistant", [
      "发现 2 处需要关注：",
      "",
      "1. `routes/orders.ts:42` 的 `catch {}` 直接返回空列表，数据库故障会被当成“没有订单”；",
      "2. `services/payment.ts:88` 重试结束后没有记录最后一次错误。",
      "",
      "建议改为抛出 `HttpError(503)` 并补充日志。",
    ].join("\n"), 182),
  ];
  const turns: Turn[] = [
    historyTurn(ids.refactorSession, "m-1", "m-2", 40, [
      { id: "r-1", kind: "reasoning", text: "先找出所有读写购物车状态的组件，再决定 hook 的接口。" },
      { id: "t-1", kind: "tool", tool: { id: "t-1", name: "Grep", input: { pattern: "cartItems", path: "src" }, output: "src/pages/CartPage.tsx\nsrc/components/MiniCart.tsx\nsrc/components/CheckoutSummary.tsx", status: "completed" } },
      { id: "t-2", kind: "tool", tool: { id: "t-2", name: "Write", input: { file_path: "src/cart/useCart.ts" }, output: "File created", status: "completed" } },
      { id: "t-3", kind: "tool", tool: { id: "t-3", name: "Bash", input: { command: "npm run typecheck" }, output: "> tsc -b\n", status: "completed" } },
    ]),
    historyTurn(ids.reviewSession, "m-3", "m-4", 185, [
      { id: "t-4", kind: "tool", tool: { id: "t-4", name: "shell", input: { command: "rg -n \"catch\" src/routes src/services" }, output: "src/routes/orders.ts:42:  } catch {\nsrc/services/payment.ts:88:  } catch (error) {", status: "completed" } },
    ]),
  ];
  return { user, users, slots, hosts, projects, sessions, messages, turns };
}
