import type { RunControl } from './run-control.js';
import { orchestrationModeOf, superReadModeOf } from './orchestration-tools.js';
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
  /** `images` counts the images attached to a queued message. */
  queue: { id: string; content: string; queuedAt: string; images: number }[];
  tasks: RunTask[];
  switching?: { fromSlotId: string; attempt: number; waitingForTasks?: boolean };
  settling?: boolean;
}

export const settingsKey = (context: AgentContext) => JSON.stringify([context.slot.id, context.slot.credential_revision,
  context.session.model ?? null, context.session.reasoning_effort ?? null, context.session.permission_mode ?? null,
  context.session.agent_mode ?? null, context.session.role_preset ?? null, orchestrationModeOf(context.session),
  context.session.agent_access ?? null]);

export function isIdleResidentRun(state: ActiveRun, failingOver: boolean): boolean {
  return !failingOver && !state.finishing && !state.closing
    && !!state.run && !state.turnActive && !state.queue.length && state.run.isIdle();
}

export function hasResidentBackgroundWork(state: ActiveRun | undefined): boolean {
  return !!state?.run && !state.finishing && !state.closing && !state.turnActive && !state.run.isIdle();
}

export function acceptsResidentContext(state: ActiveRun | undefined, context: AgentContext, failingOver: boolean): boolean {
  return !failingOver && !!state?.run && !state.finishing && !state.closing && !state.context.session.command
    && !context.session.command && state.settings === settingsKey(context)
    && superReadModeOf(state.context.session) === superReadModeOf(context.session);
}

export function runtimeViewOf(state: ActiveRun | undefined): RuntimeView {
  return {
    resident: !!state && !state.finishing && !state.closing,
    turnActive: !!state?.turnActive,
    queue: state?.queue.map(({ id, content, queuedAt, images }) => ({ id, content, queuedAt, images: images?.length ?? 0 })) ?? [],
    tasks: state?.run?.tasks() ?? [],
  };
}

export function summarizeActiveRuns(
  active: Map<string, ActiveRun>,
  failingOver: (sessionId: string) => boolean,
): { activeSessions: number; idleResidentSessions: number } {
  let activeSessions = 0;
  let idleResidentSessions = 0;
  for (const [sessionId, state] of active) {
    if (state.finishing || state.closing) continue;
    if (isIdleResidentRun(state, failingOver(sessionId))) idleResidentSessions++;
    else activeSessions++;
  }
  return { activeSessions, idleResidentSessions };
}
