import type { Store } from '../../database.js';
import type { ActivityItem, ConversationStore, ConversationTurn } from '../../conversation.js';

export const BTW_SYSTEM_PROMPT = [
  'You are answering a read-only side question (/btw) alongside an ongoing or paused main conversation.',
  'Strict rules:',
  '1. Answer directly and concisely based ONLY on the conversation history and live in-progress turn context provided.',
  '2. NEVER call any tools, NEVER read or edit files, NEVER run shell commands, and NEVER spawn subagents.',
  '3. Do NOT treat this side question as a new main task or modify any ongoing plan.',
  '4. If the answer cannot be confirmed from the provided context without inspecting files or running commands, say so briefly and directly.',
].join('\n');

const DEFAULT_SNAPSHOT_BUDGET = 48_000;
const ACTIVE_TURN_BUDGET = 16_000;
const TOOL_OUTPUT_LIMIT = 900;
const TOOL_INPUT_LIMIT = 300;

function trimBlock(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 40) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 16)}...[truncated]`;
}

function summarizeActivityItem(item: ActivityItem): string | null {
  if (item.kind === 'text' && item.text?.trim()) {
    return `[assistant draft]\n${trimBlock(item.text, 4000)}`;
  }
  if (item.kind === 'reasoning' && item.text?.trim()) {
    return `[thinking]\n${trimBlock(item.text, 1800)}`;
  }
  if (item.kind === 'tool' && item.tool) {
    const input = item.tool.input !== undefined
      ? trimBlock(typeof item.tool.input === 'string' ? item.tool.input : JSON.stringify(item.tool.input), TOOL_INPUT_LIMIT)
      : '';
    const output = item.tool.output ? trimBlock(item.tool.output, TOOL_OUTPUT_LIMIT) : '';
    const status = item.tool.status ? ` (${item.tool.status})` : '';
    const parts = [`[tool: ${item.tool.name}${status}]`];
    if (input) parts.push(`input: ${input}`);
    if (output) parts.push(`output: ${output}`);
    return parts.join('\n');
  }
  return null;
}

function formatActiveTurn(turn: ConversationTurn | undefined, budget: number): string {
  if (!turn || !turn.items.length) return '';
  const blocks: string[] = [];
  let used = 0;
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const summary = summarizeActivityItem(turn.items[i]);
    if (!summary) continue;
    const cost = summary.length + 2;
    if (used + cost > budget && blocks.length > 0) break;
    blocks.unshift(trimBlock(summary, Math.max(200, budget - used)));
    used += cost;
  }
  if (!blocks.length) return '';
  return `<in_progress_turn status="${turn.status}">\n${blocks.join('\n\n')}\n</in_progress_turn>`;
}

/**
 * Builds a read-only context snapshot from persisted main-conversation messages and any live active turn.
 * Deliberately excludes `session_btw_exchanges` so side questions never pollute or recursively feed main context.
 */
export function buildBtwContextSnapshot(
  store: Store,
  turns: ConversationStore,
  sessionId: string,
  maxChars = DEFAULT_SNAPSHOT_BUDGET,
): string {
  const rows = store.all<{ role: string; content: string; source: string | null }>(
    `SELECT role, content, source FROM messages WHERE session_id=? ORDER BY rowid ASC`,
    sessionId,
  );
  const allTurns = turns.list(sessionId);
  const activeTurn = [...allTurns].reverse().find(turn => ['running', 'pausing', 'paused'].includes(turn.status));
  const activeSection = formatActiveTurn(activeTurn, Math.min(ACTIVE_TURN_BUDGET, Math.floor(maxChars * 0.4)));
  const historyBudget = Math.max(2000, maxChars - activeSection.length - 256);

  const formattedMessages: string[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row.content?.trim()) continue;
    const roleTag = row.source ? `${row.role}:${row.source}` : row.role;
    const entry = `[${roleTag}]\n${trimBlock(row.content, 6000)}`;
    if (used + entry.length + 2 > historyBudget) {
      if (!formattedMessages.length) {
        formattedMessages.unshift(trimBlock(entry, historyBudget));
      }
      break;
    }
    formattedMessages.unshift(entry);
    used += entry.length + 2;
  }

  const sections: string[] = [];
  if (formattedMessages.length) {
    sections.push(`<conversation_history>\n${formattedMessages.join('\n\n')}\n</conversation_history>`);
  }
  if (activeSection) sections.push(activeSection);
  return sections.join('\n\n');
}

export function buildBtwUserPrompt(question: string, snapshot?: string): string {
  const trimmed = question.trim();
  if (!snapshot?.trim()) {
    return [
      'Please answer the following side question (/btw) concisely based solely on the existing conversation context.',
      'Do NOT call any tools, edit any files, or run any commands.',
      '',
      `<side_question>\n${trimmed}\n</side_question>`,
    ].join('\n');
  }
  return [
    'Here is a read-only snapshot of the current conversation (including any in-progress turn).',
    'Answer the side question below directly and concisely without invoking any tools or modifying any state.',
    '',
    snapshot.trim(),
    '',
    `<side_question>\n${trimmed}\n</side_question>`,
  ].join('\n');
}
