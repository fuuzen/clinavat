import type { RunControl } from './run-control.js';
import type { AgentContext, AgentRun, QueuedInput, RunTask } from './types.js';

export interface RunContinuation { queue: QueuedInput[]; attemptedSlotIds: string[] }

export interface ActiveRun {
  userId: string;
  projectId: string;
  slotId: string;
  context: AgentContext;
  settings: string;
  abort: AbortController;
  startup: Promise<void>;
  control: RunControl;
  finishing?: boolean;
  closing?: boolean;
  halted?: boolean;
  cliStarting?: boolean;
  run?: AgentRun;
  completion?: Promise<void>;
  credentialError?: Error;
  completionError?: Error;
  flushError?: Error;
  verifyShell?: () => Promise<void>;
  turnActive: boolean;
  queue: QueuedInput[];
  attemptedSlotIds: string[];
  idleTimer?: NodeJS.Timeout;
  flushes: Promise<void>;
}

export interface RuntimeView {
  resident: boolean;
  turnActive: boolean;
  queue: { id: string; content: string; queuedAt: string }[];
  tasks: RunTask[];
  switching?: { fromSlotId: string; attempt: number; waitingForTasks?: boolean };
  settling?: boolean;
}

export const settingsKey = (context: AgentContext) => JSON.stringify([context.slot.id, context.slot.credential_revision,
  context.session.model ?? null, context.session.reasoning_effort ?? null, context.session.permission_mode ?? null,
  context.session.agent_mode ?? null, context.session.role_preset ?? null]);
