import { http } from "msw";
import { eventHandlers } from "../events";
import { terminalHandlers } from "../terminal";
import { adminHandlers } from "./admin";
import { authHandlers } from "./auth";
import { unavailable } from "./respond";
import { sessionHandlers } from "./sessions";
import { workspaceHandlers } from "./workspace";

export const handlers = [
  ...eventHandlers,
  ...terminalHandlers,
  ...authHandlers,
  ...workspaceHandlers,
  ...sessionHandlers,
  ...adminHandlers,
  http.all("/api/*", () => unavailable("执行该操作")),
];
