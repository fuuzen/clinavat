import { sse } from "msw";
import type { PoolEvent } from "../src/types";

interface EventClient {
  send(payload: { data: PoolEvent }): void;
}

const clients = new Set<EventClient>();

export function emit(event: PoolEvent): void {
  for (const client of clients) {
    try {
      client.send({ data: event });
    } catch {
      clients.delete(client);
    }
  }
}

export const eventHandlers = [
  sse<{ message: PoolEvent; heartbeat: string }>("/api/events", ({ client, request }) => {
    clients.add(client);
    // Flush an initial heartbeat so browsers fire EventSource.onopen immediately, and keep it alive.
    const beat = () => {
      try { client.send({ event: "heartbeat", data: "" }); }
      catch { clients.delete(client); }
    };
    beat();
    const timer = setInterval(beat, 20_000);
    request.signal.addEventListener("abort", () => {
      clearInterval(timer);
      clients.delete(client);
    });
  }),
];
