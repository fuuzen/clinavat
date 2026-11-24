import { isActive } from "../../../api";
import type { Message, Turn } from "../../../types";
import { parseReports } from "./AgentReports";

/** What a finished report cycle asks of the user, when it is not plain background work. */
export type CycleNotice = "decision" | "escalation" | "milestone";

/** A report message from the children and the master's answer to it, with the turns that produced the answer. */
export interface RunCycle {
  messages: Message[];
  turns: Turn[];
  agents: string[];
  toolCalls: number;
}

export type ConversationBlock =
  | { kind: "messages"; messages: Message[]; notice?: CycleNotice }
  | { kind: "run"; cycles: RunCycle[] };

export const noticeLabels: Record<CycleNotice, string> = {
  decision: "需决策",
  escalation: "异常升级",
  milestone: "阶段收官",
};

// The tool name arrives as start_agent, clinavat.start_agent or mcp__clinavat__start_agent, depending on the engine.
const directingTool = /(?:^|[._:])(start_agent|message_agent|start_discussion)$/;
const askingTool = /(?:^|[._:])(ask_question|AskUserQuestion)$/i;
const askingPhrase = /需要你(?:确认|拍板|决定|选择)|请你?(?:确认|拍板|决定|选择)|待你确认|请决定/;
const failedStatuses = new Set(["error", "interrupted"]);

function endsWithQuestion(text: string) {
  const lines = text.replace(/```[\s\S]*?```/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  return /[?？]$/.test(lines[lines.length - 1] ?? "");
}

function agentNameOf(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const { name, agent } = input as Record<string, unknown>;
  const value = typeof name === "string" ? name : agent;
  return typeof value === "string" && value ? value : null;
}

function analyse(report: Message, answer: Message, turnsByMessage: Map<string, Turn[]>) {
  const turns = [...turnsByMessage.get(report.id) ?? [], ...turnsByMessage.get(answer.id) ?? []];
  // Without its turns the cycle cannot be told apart from one that asked for a decision.
  if (!turns.length || turns.some((turn) => isActive(turn.status))) return null;
  const tools = turns.flatMap((turn) => turn.items.flatMap((item) => item.kind === "tool" && item.tool ? [item.tool] : []));
  const directing = tools.filter((tool) => directingTool.test(tool.name));
  const reports = parseReports(report.content).reports;
  const agents = [...new Set([...reports.map((entry) => entry.agent), ...directing.map((tool) => agentNameOf(tool.input))]
    .filter((name): name is string => !!name))];
  const asking = tools.some((tool) => askingTool.test(tool.name)) || askingPhrase.test(answer.content) || endsWithQuestion(answer.content);
  const failed = turns.some((turn) => turn.status === "error" || turn.status === "interrupted")
    || (reports.some((entry) => failedStatuses.has(entry.status)) && !directing.length);
  const cycle: RunCycle = { messages: [report, answer], turns, agents, toolCalls: tools.length };
  const notice: CycleNotice | null = failed ? "escalation" : asking ? "decision" : directing.length ? null : "milestone";
  return { cycle, notice };
}

/** Groups the messages into blocks: background work the master continued by itself folds, anything else shows as it is. */
export function buildConversationBlocks(messages: Message[], turnsByMessage: Map<string, Turn[]>): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const answer = messages[index + 1];
    const result = message.role === "user" && message.source === "report" && answer?.role === "assistant"
      ? analyse(message, answer, turnsByMessage) : null;
    if (!result) {
      blocks.push({ kind: "messages", messages: [message] });
      continue;
    }
    index++;
    const previous = blocks[blocks.length - 1];
    if (result.notice) blocks.push({ kind: "messages", messages: result.cycle.messages, notice: result.notice });
    else if (previous?.kind === "run") previous.cycles.push(result.cycle);
    else blocks.push({ kind: "run", cycles: [result.cycle] });
  }
  return blocks;
}
