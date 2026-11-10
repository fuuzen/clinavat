import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../models.js';
import type { QuestionMode, QuestionPolicy } from './session-settings.js';
import type { AgentCallbacks } from './types.js';

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isSecret?: boolean;
  isOther?: boolean;
  multiSelect?: boolean;
  options?: { label: string; description: string }[] | null;
}

export type UserInputAnswers = Record<string, string[]>;

/** `skipped` also covers a question cancelled because its run stopped. */
export type UserInputOutcome =
  | { status: 'answered'; answers: UserInputAnswers }
  | { status: 'skipped' }
  | { status: 'expired'; waitedMs: number }
  | { status: 'deferred' };

export interface DeferredQuestion {
  id: string;
  session_id: string;
  questions: UserInputQuestion[];
  created_at: string;
}

export interface QuestionDeadline {
  policy: QuestionPolicy;
  /** The run's timer, which excludes paused time. Returns a cancel function. */
  schedule(callback: () => void, milliseconds: number): () => void;
  /** Keeps a question the user has not answered so it can be answered later. */
  defer(question: DeferredQuestion): void;
}

const questionSchema = z.object({
  id: z.string().min(1).max(200), header: z.string().max(200), question: z.string().min(1).max(10000),
  isSecret: z.boolean().optional(), isOther: z.boolean().optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1).max(1000), description: z.string().max(5000) })).max(30).nullable().optional(),
});

interface PendingQuestion extends DeferredQuestion {
  status: 'pending';
  timeout_ms: number;
  on_timeout: QuestionMode;
}

export function validateAnswers(questions: UserInputQuestion[], answers: UserInputAnswers, skip: boolean): void {
  const expected = new Set(questions.map(question => question.id));
  if (Object.keys(answers).some(key => !expected.has(key))) throw new HttpError(400, '回答包含未知的问题');
  if (!skip && questions.some(question => !Object.hasOwn(answers, question.id) || !answers[question.id].some(answer => answer.trim()))) {
    throw new HttpError(400, '请回答每个问题，或选择跳过');
  }
}

export function describeDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

/** What the agent is told when a question gets no answer now. */
export function unansweredNotice(outcome: Exclude<UserInputOutcome, { status: 'answered' }>): string {
  if (outcome.status === 'deferred') {
    return '用户暂时不在，问题已保留在网页上等待回答。请立即结束本轮：不要继续执行依赖这些答案的步骤，也不要假定答案，只需简要说明你在等待哪些决定。用户回答后，答案会作为新消息发给你。';
  }
  const reason = outcome.status === 'expired' ? `用户在 ${describeDuration(outcome.waitedMs)}内没有回答这些问题` : '用户跳过了这些问题';
  return `${reason}，请依据已有信息继续，不要假定任何选项已获用户同意。`;
}

export class UserInputRequests {
  private pending = new Map<string, {
    request: PendingQuestion;
    finish(outcome: UserInputOutcome): void;
  }>();

  constructor(private event: AgentCallbacks['event']) {}

  list(sessionId: string) {
    return [...this.pending.values()].filter(item => item.request.session_id === sessionId).map(item => item.request);
  }

  has(sessionId: string, id: string): boolean {
    return this.pending.get(id)?.request.session_id === sessionId;
  }

  request(sessionId: string, questions: UserInputQuestion[], signal: AbortSignal, deadline: QuestionDeadline): Promise<UserInputOutcome> {
    if (signal.aborted) return Promise.resolve({ status: 'skipped' });
    questions = z.array(questionSchema).min(1).max(20).parse(questions);
    if (!questions.length || questions.length > 20 || new Set(questions.map(question => question.id)).size !== questions.length) {
      throw new Error('原生问题列表无效');
    }
    const id = randomUUID();
    const { timeoutMs } = deadline.policy;
    // A kept question is answered through a chat message, which would store a secret in the conversation.
    const deferrable = deadline.policy.mode === 'defer' && !questions.some(question => question.isSecret);
    const request: PendingQuestion = { id, session_id: sessionId, status: 'pending', questions, created_at: new Date().toISOString(),
      timeout_ms: timeoutMs, on_timeout: deferrable ? 'defer' : 'skip' };
    return new Promise(resolve => {
      let cancelTimeout = () => {};
      const finish = (outcome: UserInputOutcome) => {
        if (!this.pending.delete(id)) return;
        cancelTimeout();
        signal.removeEventListener('abort', abort);
        this.event({ type: 'user-input', sessionId, payload: { id, status: outcome.status } });
        resolve(outcome);
      };
      const abort = () => finish({ status: 'skipped' });
      const expire = () => {
        if (deferrable) {
          try {
            deadline.defer({ id, session_id: sessionId, questions, created_at: request.created_at });
            finish({ status: 'deferred' });
            return;
          } catch { /* Not kept: the agent goes on without an answer instead. */ }
        }
        finish({ status: 'expired', waitedMs: timeoutMs });
      };
      this.pending.set(id, { request, finish });
      cancelTimeout = deadline.schedule(expire, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      this.event({ type: 'user-input', sessionId, payload: request });
    });
  }

  answer(sessionId: string, id: string, answers: UserInputAnswers, skip = false) {
    const pending = this.pending.get(id);
    if (!pending || pending.request.session_id !== sessionId) throw new HttpError(409, '这个问题已结束，请刷新对话');
    validateAnswers(pending.request.questions, answers, skip);
    pending.finish(skip ? { status: 'skipped' } : { status: 'answered', answers });
  }
}
