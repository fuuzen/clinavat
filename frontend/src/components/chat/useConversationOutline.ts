import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Message, Turn } from "../../types";

export interface OutlineEntry {
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  status?: Turn["status"];
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

function turnPreview(turn?: Turn) {
  const textItems = turn?.items.filter((item) => item.kind === "text" && item.text?.trim()) || [];
  const finalItems = textItems.filter((item) => item.final);
  return (finalItems.length ? finalItems : textItems).map((item) => item.text).join("\n");
}

function buildEntries(messages: Message[], turns: Turn[]): OutlineEntry[] {
  const turnsByUser = new Map(turns.map((turn) => [turn.user_message_id, turn]));
  const messageIds = new Set(messages.map((message) => message.id));
  const assistantMessages = new Map(messages.filter((message) => message.role === "assistant")
    .map((message) => [message.id, message.content]));
  const entries: OutlineEntry[] = [];
  let current: { message: Message; responses: string[] } | undefined;

  function appendCurrent() {
    if (!current) return;
    const { message, responses } = current;
    const turn = turnsByUser.get(message.id);
    const linkedResponse = turn?.assistant_message_id ? assistantMessages.get(turn.assistant_message_id) : undefined;
    entries.push({
      id: `conversation-message-${message.id}`,
      label: summarize(message.content, 160) || "空白消息",
      preview: summarize(linkedResponse?.trim() || responses.join("\n").trim() || turnPreview(turn), 360),
      createdAt: message.created_at,
      status: turn?.status,
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

  // ConversationTurns renders records without a user message after the message list.
  for (const turn of turns) {
    if (messageIds.has(turn.user_message_id)) continue;
    entries.push({
      id: `conversation-turn-${turn.id}`,
      label: "执行记录（原始消息不可用）",
      preview: summarize(turnPreview(turn), 360),
      createdAt: turn.started_at,
      status: turn.status,
    });
  }
  return entries;
}

export function useConversationOutline(
  messages: Message[],
  turns: Turn[],
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const entries = useMemo(() => buildEntries(messages, turns), [messages, turns]);
  const [currentId, setCurrentId] = useState("");
  const anchorKey = JSON.stringify(entries.map((entry) => entry.id));

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const ids = JSON.parse(anchorKey) as string[];
    let anchors: { id: string; top: number }[] = [];
    let needsMeasure = true;
    let frame = 0;

    function update() {
      frame = 0;
      if (!scroll) return;
      const scrollTop = scroll.scrollTop;
      const viewportHeight = scroll.clientHeight;
      const contentHeight = scroll.scrollHeight;
      if (needsMeasure) {
        const viewportTop = scroll.getBoundingClientRect().top;
        anchors = ids.flatMap((id) => {
          const element = document.getElementById(id);
          return element && scroll.contains(element)
            ? [{ id, top: element.getBoundingClientRect().top - viewportTop + scrollTop }]
            : [];
        });
        needsMeasure = false;
      }
      let selected = anchors[0]?.id || "";
      if (contentHeight > viewportHeight + 1 && contentHeight - viewportHeight - scrollTop <= 2) {
        selected = anchors[anchors.length - 1]?.id || "";
      } else {
        let low = 0;
        let high = anchors.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (anchors[middle].top <= scrollTop + 48) {
            selected = anchors[middle].id;
            low = middle + 1;
          } else high = middle - 1;
        }
      }
      setCurrentId(selected);
    }

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(() => {
      needsMeasure = true;
      schedule();
    });
    observer.observe(scroll);
    const conversation = scroll.querySelector(".conversation");
    if (conversation) observer.observe(conversation);
    scroll.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.removeEventListener("scroll", schedule);
    };
  }, [anchorKey, scrollRef]);

  return { entries, currentId, setCurrentId };
}
