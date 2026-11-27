import type { RunControl } from './run-control.js';
import { hasClientDirectTools, orchestrationModeOf, superReadModeOf } from './orchestration-tools.js';
import type { AgentContext, AgentErrorDetail, AgentRun, QueuedInput, QuotaFailure, RunTask } from './types.js';
import type { SlotUsage } from '../accounts/usage.js';
import { relevantWindowsForEngine } from '../accounts/selection.js';

const quotaErrorPattern = /usage[_\s-]*limit|rate[_\s-]*limit|resource[_\s-]*exhausted|too\s+many\s+requests|\b429\b|quota|hit\s+your\s+limit|limit\s+reached|额度|限流|受限|自动切换账号失败/i;

export function isQuotaErrorMessage(message: string): boolean {
  return quotaErrorPattern.test(message);
}

/** Builds a structured error payload so observers receive slot, quota and reset details before turn-state(error). */
export function buildAgentErrorPayload(
  message: string,
  context: AgentContext,
  options: { turnId?: string; quota?: QuotaFailure; attemptedSlotIds?: string[]; usage?: SlotUsage } = {},
): AgentErrorDetail {
  const quotaError = !!options.quota || isQuotaErrorMessage(message);
  let window = options.quota?.window ?? null;
  let resetsAt = options.quota?.resetsAt ?? null;
  if (quotaError && (!resetsAt || !window) && options.usage) {
    const view = options.usage.view(context.slot.id);
    if (view.state === 'ok') {
      const now = Date.now();
      const relevant = relevantWindowsForEngine(context.session.engine, view.windows, context.session.model);
      const preferred = (window ? relevant.find(item => item.key === window) : undefined)
        ?? (view.limitingWindow ? relevant.find(item => item.key === view.limitingWindow) : undefined)
        ?? relevant.find(item => item.limited && item.resetsAt && Date.parse(item.resetsAt) > now)
        ?? relevant.find(item => item.resetsAt && Date.parse(item.resetsAt) > now);
      if (preferred) {
        window ??= preferred.key;
        if (!resetsAt && preferred.resetsAt && Date.parse(preferred.resetsAt) > now) resetsAt = preferred.resetsAt;
      }
    }
  }
  return {
    ...(options.turnId ? { turnId: options.turnId } : {}),
    message,
    errorKind: quotaError ? 'quota_exceeded' : 'runtime_error',
    slotId: context.slot.id,
    engine: context.session.engine,
    model: context.session.model ?? null,
    ...(window ? { window } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(options.attemptedSlotIds?.length ? { attemptedSlotIds: options.attemptedSlotIds } : {}),
  };
}

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
  /** Steer inputs accepted by the engine (`run.steer === true`) that have not yet been consumed into the turn. */
  pendingSteers: QueuedInput[];
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

export const settingsKey = (context: AgentContext) => JSON.stringify([
  context.slot.id,
  context.slot.credential_revision,
  context.session.model ?? null,
  context.session.reasoning_effort ?? null,
  context.session.permission_mode ?? null,
  context.session.agent_mode ?? null,
  context.session.role_preset ?? null,
  orchestrationModeOf(context.session),
  context.session.agent_access ?? null,
  context.host?.kind ?? 'ssh',
  context.project.client_mode ?? null,
  context.project.vm_path ?? null,
  context.host?.platform ?? null,
  context.host?.default_shell ?? null,
  context.session.agent_directory ?? null,
  hasClientDirectTools(context) ? (context.session.agent_access === 'read' ? 'client-direct-ro' : 'client-direct-rw') : 'native',
]);

export function isIdleResidentRun(state: ActiveRun, failingOver: boolean): boolean {
  return !failingOver && !state.finishing && !state.closing
    && !!state.run && !state.turnActive && !state.queue.length && state.run.isIdle();
}

/** Moves unconsumed steering inputs to the front of `queue` with their saved `messageId` intact so nothing is lost or duplicated on failover/teardown. */
export function rescueUnconsumedSteers(state: ActiveRun, queue: QueuedInput[]): boolean {
  if (!state.pendingSteers.length) return false;
  const existing = new Set(queue.map(item => item.messageId ?? item.id));
  const rescued = state.pendingSteers.filter(item => !existing.has(item.messageId ?? item.id));
  state.pendingSteers = [];
  if (!rescued.length) return false;
  queue.unshift(...rescued);
  return true;
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
