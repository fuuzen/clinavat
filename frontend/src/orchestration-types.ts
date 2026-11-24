import type { AgentEngine } from "./engines";

/** A master conversation's children as its agent panel shows them. */
export interface ChildAgent {
  sessionId: string;
  name: string;
  engine: AgentEngine;
  model: string | null;
  slotId: string | null;
  access: "read" | "write";
  status: string;
  archived: boolean;
  ephemeral?: boolean;
  /** A task from the master is in progress. */
  running: boolean;
  /** Relative to the child's project root; null for the root. */
  directory: string | null;
  isolation: "shared" | "worktree";
  /** The child's own branch: "working" while it runs, "changes" to merge, "clean" once removed. */
  worktree: { branch: string | null; state: "working" | "changes" | "conflict" | "resolving" | "clean"; conflicts: string[] } | null;
  lastTask: { status: "running" | "completed" | "interrupted" | "error"; finishedAt: string | null } | null;
  pendingReports: number;
}
/** Site-wide limits on master agents and their children. */
export interface OrchestrationSettings {
  runningPerMaster: number;
  runningPerUser: number;
  sharedWritersPerMaster: number;
  worktreeWritersPerMaster: number;
  reportTurnsPerMessage: number;
  discussionParticipants: number;
  debateRounds: number;
}
export type DiscussionFormat = "council" | "debate" | "review";
/** A discussion hosted by a conversation: the master that started it, or the moderator created for it. */
export interface DiscussionView {
  id: string;
  topic: string;
  format: DiscussionFormat;
  status: "running" | "completed" | "stopped" | "error";
  detail: string | null;
  round: number;
  rounds: number;
  startedBy: "master" | "user";
  participants: {
    sessionId: string; name: string; engine: AgentEngine; model: string | null; stance: string | null; running: boolean;
    statements: { round: number; status: string }[];
  }[];
}
export type WorkItemStatus = "pending" | "in_progress" | "verifying" | "blocked" | "completed" | "cancelled";
export interface WorkItemView {
  id: string;
  code: string;
  title: string;
  description: string | null;
  acceptance: string | null;
  status: WorkItemStatus;
  assignedAgent: string | null;
  dependsOn: string[];
  summary: string | null;
  updatedAt: string;
}
export interface MemoryEntryView {
  key: string;
  content: string;
  updatedAt: string;
}
export interface AgentPanelView {
  agents: ChildAgent[];
  tasks: WorkItemView[];
  memories: MemoryEntryView[];
  discussions: DiscussionView[];
  /** Finished reports the master has not received yet. */
  pendingReports: number;
  /** Automatic report turns reached their limit; the rest wait for the user. */
  reportsPaused: boolean;
}

export type AgentMode = "normal" | "plan";
export type RolePreset = "default" | "reviewer" | "architect";
export type OrchestrationMode = "off" | "hybrid" | "super";
/** 'overview' limits a Super Agent to the directory tree and documents; 'full' allows capped source reads. */
export type SuperReadMode = "off" | "overview" | "full";
export interface AgentBehavior {
  agentMode: AgentMode;
  rolePreset: RolePreset;
  /** The agent may start and direct child agents. */
  orchestration: boolean;
  /** 'off' for plain conversations, 'hybrid' for full-access master, 'super' for read-only delegate-first coordinator. */
  orchestrationMode: OrchestrationMode;
  superReadMode?: SuperReadMode;
}

/** A named child agent in the user's roster. */
export interface AgentProfile {
  id: string;
  name: string;
  engine: AgentEngine;
  slot_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  access: "read" | "write";
  instructions: string | null;
}
