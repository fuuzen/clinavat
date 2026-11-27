import type { ActivityItem, Message, Turn } from "../../../types";

export type OutlineStatus = Turn["status"] | "steered" | "pending-steer";

export interface OutlineEntry {
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  status?: OutlineStatus;
}

export interface TurnSegment {
  key: string;
  turn: Turn;
  index: number;
  total: number;
  items: ActivityItem[];
  anchorMessageId: string;
  startedAt: string;
  endedAt: string | null;
  steered: boolean;
  live: boolean;
  isLast: boolean;
}

export interface ConversationTurnPlan {
  beforeMessage: Map<string, TurnSegment[]>;
  afterMessage: Map<string, TurnSegment[]>;
  turnsByMessage: Map<string, Turn[]>;
  unanchoredTurns: Turn[];
  pendingSteerMessageIds: Set<string>;
  segmentByAnchor: Map<string, TurnSegment>;
}

const activeStatuses = new Set<Turn["status"]>(["running", "pausing", "paused"]);
const isTurnActive = (status: Turn["status"]) => activeStatuses.has(status);
const isTurnTailItem = (item: Pick<ActivityItem, "id">) => item.id === "turn-diff" || item.id === "native-plan";

/** Filters a segment's items down to what `TurnProcess` displays. */
export function displayableSegmentItems(items: ActivityItem[], live: boolean): ActivityItem[] {
  return items.filter((item) => item.kind !== "steer"
    && (live || !item.final)
    && !(item.kind === "reasoning" && !item.text?.trim()));
}

/** Avoids rendering empty sealed pre-steer boxes or empty finished trailing boxes when a final answer already follows. */
export function shouldRenderSegment(segment: TurnSegment): boolean {
  if (segment.total === 1) return true;
  if (segment.steered) return displayableSegmentItems(segment.items, false).length > 0;
  return segment.live
    || displayableSegmentItems(segment.items, false).length > 0
    || segment.turn.status !== "completed"
    || !segment.turn.assistant_message_id;
}

/**
 * Splits a turn's stream into segments at each consumed `kind: 'steer'` marker whose message is loaded.
 * Turn-level singletons (`turn-diff`, `native-plan`) are always mounted on the final segment.
 */
export function splitTurnSegments(turn: Turn, messageIds: Set<string>, initialAnchor = turn.user_message_id): TurnSegment[] {
  const streamItems: ActivityItem[] = [];
  const tailItems: ActivityItem[] = [];
  for (const item of turn.items) {
    if (isTurnTailItem(item)) tailItems.push(item);
    else streamItems.push(item);
  }
  const raw: { anchorMessageId: string; startedAt: string; endedAt: string | null; items: ActivityItem[] }[] = [];
  let current = { anchorMessageId: initialAnchor, startedAt: turn.started_at, endedAt: null as string | null, items: [] as ActivityItem[] };
  const seenSteers = new Set<string>();
  for (const item of streamItems) {
    if (item.kind === "steer") {
      const targetId = item.messageId;
      if (targetId && targetId !== turn.user_message_id && !seenSteers.has(targetId) && messageIds.has(targetId)) {
        seenSteers.add(targetId);
        current.endedAt = item.at ?? null;
        raw.push(current);
        current = { anchorMessageId: targetId, startedAt: item.at ?? turn.started_at, endedAt: null, items: [] };
      }
      continue;
    }
    current.items.push(item);
  }
  current.items.push(...tailItems);
  current.endedAt = turn.completed_at ?? null;
  raw.push(current);

  const total = raw.length;
  const liveTurn = isTurnActive(turn.status);
  return raw.map((segment, index) => {
    const isLast = index === total - 1;
    return {
      key: index === 0 ? `${turn.id}:seg:0` : `${turn.id}:seg:${segment.anchorMessageId}`,
      turn,
      index,
      total,
      items: segment.items,
      anchorMessageId: segment.anchorMessageId,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      steered: !isLast,
      live: isLast && liveTurn,
      isLast,
    };
  });
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Computes where every turn segment attaches in the message timeline, plus any unconsumed pending steer messages. */
export function planConversationTurns(messages: Message[], turns: Turn[]): ConversationTurnPlan {
  const messageIds = new Set(messages.map((message) => message.id));
  const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
  const turnUserIds = new Set(turns.map((turn) => turn.user_message_id));
  const beforeMessage = new Map<string, TurnSegment[]>();
  const afterMessage = new Map<string, TurnSegment[]>();
  const turnsByMessage = new Map<string, Turn[]>();
  const unanchoredTurns: Turn[] = [];
  const pendingSteerMessageIds = new Set<string>();
  const segmentByAnchor = new Map<string, TurnSegment>();
  const previousByUser = new Map<string, Turn>();
  const consumedSteerIds = new Set<string>();

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    const previousAnswer = previousByUser.get(turn.user_message_id)?.assistant_message_id;
    const initialAnchor = messageIds.has(turn.user_message_id) && previousAnswer && messageIds.has(previousAnswer)
      ? previousAnswer : turn.user_message_id;
    pushToMap(turnsByMessage, initialAnchor, turn);
    previousByUser.set(turn.user_message_id, turn);

    for (const item of turn.items) {
      if (item.kind === "steer" && item.messageId) consumedSteerIds.add(item.messageId);
    }

    const segments = splitTurnSegments(turn, messageIds, initialAnchor);
    if (segments.length === 1 && !messageIds.has(segments[0].anchorMessageId)) {
      unanchoredTurns.push(turn);
    } else {
      const first = segments[0];
      if (messageIds.has(first.anchorMessageId)) {
        if (shouldRenderSegment(first)) pushToMap(afterMessage, first.anchorMessageId, first);
        segmentByAnchor.set(first.anchorMessageId, first);
      } else if (segments.length > 1) {
        // Older initial message was trimmed by pagination; keep the pre-steer segment right above the first loaded steer message.
        if (shouldRenderSegment(first)) pushToMap(beforeMessage, segments[1].anchorMessageId, first);
      }
      for (const segment of segments.slice(1)) {
        if (shouldRenderSegment(segment)) pushToMap(afterMessage, segment.anchorMessageId, segment);
        segmentByAnchor.set(segment.anchorMessageId, segment);
      }
    }

    if (isTurnActive(turn.status)) {
      const firstVisibleAnchor = segments.find((segment) => messageIds.has(segment.anchorMessageId))?.anchorMessageId;
      const startIndex = messageIndex.get(turn.user_message_id)
        ?? (firstVisibleAnchor ? messageIndex.get(firstVisibleAnchor) : undefined)
        ?? -1;
      let endIndex = messages.length;
      for (let later = turnIndex + 1; later < turns.length; later++) {
        const laterIndex = messageIndex.get(turns[later].user_message_id);
        if (laterIndex !== undefined && laterIndex > startIndex) {
          endIndex = laterIndex;
          break;
        }
      }
      for (let index = startIndex + 1; index < endIndex; index++) {
        const candidate = messages[index];
        if (candidate.role === "user" && !turnUserIds.has(candidate.id) && !consumedSteerIds.has(candidate.id)) {
          pendingSteerMessageIds.add(candidate.id);
        }
      }
    }
  }

  return { beforeMessage, afterMessage, turnsByMessage, unanchoredTurns, pendingSteerMessageIds, segmentByAnchor };
}

function summarize(content: string, limit: number) {
  const text = content
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function itemsTextPreview(items: ActivityItem[]) {
  const textItems = items.filter((item) => item.kind === "text" && item.text?.trim());
  const finalItems = textItems.filter((item) => item.final);
  return (finalItems.length ? finalItems : textItems).map((item) => item.text).join("\n");
}

/** Builds outline entries aligned with segmented turns, steered pre-segments, pending steers, and pagination fallbacks. */
export function buildOutlineEntries(messages: Message[], turns: Turn[]): OutlineEntry[] {
  const plan = planConversationTurns(messages, turns);
  const assistantMessages = new Map(messages.filter((message) => message.role === "assistant")
    .map((message) => [message.id, message.content]));
  const entries: OutlineEntry[] = [];
  let current: { message: Message; responses: string[] } | undefined;

  function appendCurrent() {
    if (!current) return;
    const { message, responses } = current;
    const segment = plan.segmentByAnchor.get(message.id);
    let status: OutlineStatus | undefined;
    let previewText = "";
    if (segment) {
      if (segment.steered) {
        status = "steered";
        previewText = itemsTextPreview(segment.items);
      } else {
        status = segment.turn.status;
        const linkedResponse = segment.turn.assistant_message_id ? assistantMessages.get(segment.turn.assistant_message_id) : undefined;
        previewText = linkedResponse?.trim() || responses.join("\n").trim() || itemsTextPreview(segment.items);
      }
    } else if (plan.pendingSteerMessageIds.has(message.id)) {
      status = "pending-steer";
      previewText = responses.join("\n").trim();
    } else {
      previewText = responses.join("\n").trim();
    }
    entries.push({
      id: `conversation-message-${message.id}`,
      label: summarize(message.content, 160) || (message.images ? "图片" : "空白消息"),
      preview: summarize(previewText, 360),
      createdAt: message.created_at,
      status,
    });
  }

  for (const message of messages) {
    if (message.role === "user") {
      appendCurrent();
      current = { message, responses: [] };
    } else if (message.role === "assistant" && current) {
      current.responses.push(message.content);
    }
  }
  appendCurrent();

  // ConversationTurns renders records with no loaded message anchor after the message list.
  for (const turn of plan.unanchoredTurns) {
    entries.push({
      id: `conversation-turn-${turn.id}`,
      label: "执行记录（原始消息不可用）",
      preview: summarize(itemsTextPreview(turn.items), 360),
      createdAt: turn.started_at,
      status: turn.status,
    });
  }
  return entries;
}
