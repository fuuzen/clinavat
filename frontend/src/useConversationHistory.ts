import { useCallback, useRef, useState, type RefObject } from "react";
import { api } from "./api";
import type { Message, Turn } from "./types";

export function useConversationHistory(selectedSessionRef: RefObject<string>) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const requestRef = useRef(0);
  const turnVersionsRef = useRef(new Map<string, number>());

  const reloadMessages = useCallback(async (id: string) => {
    if (selectedSessionRef.current !== id) return;
    const request = ++requestRef.current;
    const turnVersions = new Map(turnVersionsRef.current);
    const [savedMessages, savedTurns] = await Promise.all([
      api<Message[]>(`/sessions/${id}/messages`),
      api<Turn[]>(`/sessions/${id}/turns`),
    ]);
    if (selectedSessionRef.current !== id || request !== requestRef.current)
      return;
    setMessages(savedMessages);
    setTurns((previous) => {
      const latest = new Map(savedTurns.map((turn) => [turn.id, turn]));
      for (const turn of previous) {
        if ((turnVersionsRef.current.get(turn.id) || 0) <= (turnVersions.get(turn.id) || 0))
          continue;
        const saved = latest.get(turn.id);
        // A replayed running event must not reopen a turn already saved as finished.
        if (saved && saved.status !== "running" && turn.status === "running") continue;
        latest.set(turn.id, turn);
      }
      return [...latest.values()];
    });
  }, [selectedSessionRef]);

  const receiveTurn = useCallback((turn: Turn) => {
    if (turn.session_id !== selectedSessionRef.current) return;
    turnVersionsRef.current.set(turn.id, (turnVersionsRef.current.get(turn.id) || 0) + 1);
    setTurns((previous) => previous.some((item) => item.id === turn.id)
      ? previous.map((item) => (item.id === turn.id
        ? item.status !== "running" && turn.status === "running" ? item : turn
        : item))
      : [...previous, turn]);
  }, [selectedSessionRef]);

  const resetHistory = useCallback(() => {
    requestRef.current += 1;
    turnVersionsRef.current.clear();
    setMessages([]);
    setTurns([]);
  }, []);

  return { messages, turns, reloadMessages, receiveTurn, resetHistory };
}
