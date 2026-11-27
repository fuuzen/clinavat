import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Message, Turn } from "../../types";
import { buildOutlineEntries, type OutlineEntry, type OutlineStatus } from "./native/turnSegments";

export type { OutlineEntry, OutlineStatus };

export function useConversationOutline(
  messages: Message[],
  turns: Turn[],
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const entries = useMemo(() => buildOutlineEntries(messages, turns), [messages, turns]);
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
          // Anchors inside collapsed (display: none) groups have no position to measure.
          return element && scroll.contains(element) && element.getClientRects().length
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
