import { z } from 'zod';
import type { Store } from '../database.js';

const count = (min: number, max: number) => z.number().int().min(min, `不能少于 ${min}`).max(max, `不能超过 ${max}`);

/** What a master agent may do with its children; administrators change these in the panel. */
export const orchestrationSettingsSchema = z.object({
  /** Children with a task in progress, per master and per user. */
  runningPerMaster: count(1, 16),
  runningPerUser: count(1, 64),
  /** Writing children that share the project directory, per master; their directories must not contain each other. */
  sharedWritersPerMaster: count(0, 8),
  /** Writing children in their own Git worktree, per master; each costs a mirror and a sync session. */
  worktreeWritersPerMaster: count(0, 8),
  /** Automatic report turns after the user's last message; later reports wait for the user. */
  reportTurnsPerMessage: count(1, 100),
  /** Participants of one discussion; they run at the same time, outside the per-master limit. */
  discussionParticipants: count(2, 8),
  /** Rounds a debate may take before it ends without agreement. */
  debateRounds: count(1, 10),
}).strict();
export type OrchestrationSettings = z.infer<typeof orchestrationSettingsSchema>;

export const orchestrationDefaults: OrchestrationSettings = {
  runningPerMaster: 4, runningPerUser: 8, sharedWritersPerMaster: 1, worktreeWritersPerMaster: 4, reportTurnsPerMessage: 20,
  discussionParticipants: 5, debateRounds: 4,
};

/** Fixed by the protocol rather than by policy. */
export const orchestrationConstants = {
  /** A report longer than this is cut; the master can read the rest with read_agent. */
  reportCharacters: 16 * 1024,
  /** Compact report budget injected into a Super Agent's prompt; full text stays available via read_agent. */
  superReportCharacters: 4 * 1024,
  /** Compact per-statement budget injected into a Super Agent's discussion digest; full text stays via read_discussion. */
  superStatementCharacters: 2 * 1024,
  /** wait_agents returns after this at the latest; both CLIs keep a tool call open at least this long. */
  waitSeconds: 600,
  /** Reports finishing within this window reach the master as one message. */
  deliveryDelayMs: 2000,
  /**
   * How long a child's report waits after its turn ends while its CLI still runs background work; it is sent as soon
   * as a later turn ends or the process exits, and after this with a note that the work was still running.
   */
  backgroundReportWaitMs: 30 * 60_000,
  /** Statements of the others in one participant's prompt, shared out so that shorter ones stay whole. */
  discussionPromptCharacters: 64 * 1024,
  /** Statements in the host's prompt when the host is not a Super Agent. */
  discussionHostCharacters: 48 * 1024,
  /** Statements in the saved record, which must fit one message. */
  discussionRecordCharacters: 80_000,
} as const;

export class OrchestrationSettingsStore {
  private cached?: OrchestrationSettings;

  constructor(private readonly store: Store) {}

  view(): OrchestrationSettings {
    if (this.cached) return this.cached;
    const row = this.store.get<{ config: string }>('SELECT config FROM orchestration_settings WHERE id=1');
    // A stored value from an older version keeps what it has and takes today's defaults for the rest.
    const parsed = row ? orchestrationSettingsSchema.partial().safeParse(JSON.parse(row.config)) : undefined;
    this.cached = { ...orchestrationDefaults, ...(parsed?.success ? parsed.data : {}) };
    return this.cached;
  }

  update(settings: OrchestrationSettings): OrchestrationSettings {
    this.store.run(`INSERT INTO orchestration_settings(id,config) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET config=excluded.config`, JSON.stringify(orchestrationSettingsSchema.parse(settings)));
    this.cached = undefined;
    return this.view();
  }
}
