import type { PermissionMode } from "./types";

/** The CLIs a slot can hold, and what the web view shows and offers for each. Keep in line with backend/src/agent/engines.ts. */
export const agentEngines = ["claude", "codex"] as const;
export type AgentEngine = typeof agentEngines[number];

export interface EngineProfile {
  label: string;
  permissionModes: readonly PermissionMode[];
  /** Conversations may let the Hub choose the account and switch it when the quota runs out. */
  automaticSlot: boolean;
  /** A slot may log in with a long-lived token instead of a browser login. */
  setupToken: boolean;
  rolePresets: boolean;
  goal: boolean;
  /** How the account's limits can be reset: Claude's weekly reset of the 5-hour window, or Codex's reset credits. */
  limitReset: "weekly" | "credits";
}

export const engineProfiles: Record<AgentEngine, EngineProfile> = {
  claude: {
    label: "Claude Code",
    permissionModes: ["manual", "accept-edits", "auto", "full-access", "yolo"],
    automaticSlot: true,
    setupToken: true,
    rolePresets: false,
    goal: false,
    limitReset: "weekly",
  },
  codex: {
    label: "Codex",
    permissionModes: ["manual", "auto", "full-access", "yolo"],
    automaticSlot: false,
    setupToken: false,
    rolePresets: true,
    goal: true,
    limitReset: "credits",
  },
};

export const engineLabel = (engine: AgentEngine) => engineProfiles[engine].label;
