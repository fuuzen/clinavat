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
  sse<{ message: PoolEvent }>("/api/events", ({ client, request }) => {
    clients.add(client);
    request.signal.addEventListener("abort", () => clients.delete(client));
  }),
];
