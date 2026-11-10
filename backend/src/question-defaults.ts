import { z } from 'zod';
import type { Store } from './database.js';
import { questionModes, questionTimeoutRange, type QuestionMode, type QuestionPolicy } from './agent/session-settings.js';

export const questionTimeout = z.number().int()
  .min(questionTimeoutRange.min, '等待时间不能少于 1 分钟').max(questionTimeoutRange.max, '等待时间不能超过 24 小时');
export const questionPolicySchema = z.object({ mode: z.enum(questionModes), timeoutMs: questionTimeout }).strict();
/** A user's own defaults; a field left null follows the site. */
export const questionPreferenceSchema = z.object({
  mode: z.enum(questionModes).nullable(), timeoutMs: questionTimeout.nullable(),
}).strict();
export type QuestionPreference = z.infer<typeof questionPreferenceSchema>;

interface StoredPreference { question_mode: QuestionMode | null; question_timeout_ms: number | null }

/** Resolves each question setting from the conversation, then its user's defaults, then the site's. */
export class QuestionDefaults {
  private readonly builtIn: QuestionPolicy;

  constructor(private readonly store: Store, approvalTimeoutMs: number) {
    this.builtIn = { mode: 'skip',
      timeoutMs: Math.min(questionTimeoutRange.max, Math.max(questionTimeoutRange.min, approvalTimeoutMs)) };
  }

  site(): QuestionPolicy {
    const row = this.store.get<{ mode: QuestionMode; timeout_ms: number }>('SELECT mode,timeout_ms FROM question_defaults WHERE id=1');
    return row ? { mode: row.mode, timeoutMs: row.timeout_ms } : this.builtIn;
  }

  updateSite(policy: QuestionPolicy): QuestionPolicy {
    this.store.run(`INSERT INTO question_defaults(id,mode,timeout_ms) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,timeout_ms=excluded.timeout_ms`, policy.mode, policy.timeoutMs);
    return this.site();
  }

  user(userId: string): QuestionPreference {
    const row = this.store.get<StoredPreference>('SELECT question_mode,question_timeout_ms FROM users WHERE id=?', userId);
    return { mode: row?.question_mode ?? null, timeoutMs: row?.question_timeout_ms ?? null };
  }

  updateUser(userId: string, preference: QuestionPreference): QuestionPreference {
    this.store.run('UPDATE users SET question_mode=?,question_timeout_ms=? WHERE id=?', preference.mode, preference.timeoutMs, userId);
    return this.user(userId);
  }

  /** What a new conversation of this user does. */
  forUser(userId: string): QuestionPolicy {
    return this.resolve(this.user(userId), this.site());
  }

  forSession(sessionId: string): QuestionPolicy {
    const session = this.store.get<StoredPreference & { user_id: string }>(
      'SELECT user_id,question_mode,question_timeout_ms FROM sessions WHERE id=?', sessionId);
    if (!session) return this.site();
    return this.resolve({ mode: session.question_mode, timeoutMs: session.question_timeout_ms }, this.forUser(session.user_id));
  }

  private resolve(preference: QuestionPreference, fallback: QuestionPolicy): QuestionPolicy {
    return { mode: preference.mode ?? fallback.mode, timeoutMs: preference.timeoutMs ?? fallback.timeoutMs };
  }
}
