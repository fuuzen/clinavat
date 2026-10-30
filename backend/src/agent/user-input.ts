import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../models.js';
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

const questionSchema = z.object({
  id: z.string().min(1).max(200), header: z.string().max(200), question: z.string().min(1).max(10000),
  isSecret: z.boolean().optional(), isOther: z.boolean().optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1).max(1000), description: z.string().max(5000) })).max(30).nullable().optional(),
});

interface PendingQuestion {
  id: string;
  session_id: string;
  status: 'pending';
  questions: UserInputQuestion[];
  created_at: string;
}

export class UserInputRequests {
  private pending = new Map<string, {
    request: PendingQuestion;
    finish(answers: UserInputAnswers | null): void;
  }>();

  constructor(private event: AgentCallbacks['event']) {}

  list(sessionId: string) {
    return [...this.pending.values()].filter(item => item.request.session_id === sessionId).map(item => item.request);
  }

  request(sessionId: string, questions: UserInputQuestion[], signal: AbortSignal): Promise<UserInputAnswers | null> {
    if (signal.aborted) return Promise.resolve(null);
    questions = z.array(questionSchema).min(1).max(20).parse(questions);
    if (!questions.length || questions.length > 20 || new Set(questions.map(question => question.id)).size !== questions.length) {
      throw new Error('原生问题列表无效');
    }
    const id = randomUUID();
    const request: PendingQuestion = { id, session_id: sessionId, status: 'pending', questions, created_at: new Date().toISOString() };
    return new Promise(resolve => {
      const abort = () => finish(null);
      const finish = (answers: UserInputAnswers | null) => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener('abort', abort);
        this.event({ type: 'user-input', sessionId, payload: { id, status: answers === null ? 'cancelled' : 'answered' } });
        resolve(answers);
      };
      this.pending.set(id, { request, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.event({ type: 'user-input', sessionId, payload: request });
    });
  }

  answer(sessionId: string, id: string, answers: UserInputAnswers, skip = false) {
    const pending = this.pending.get(id);
    if (!pending || pending.request.session_id !== sessionId) throw new HttpError(409, '这个问题已结束，请刷新对话');
    const questions = pending.request.questions;
    const expected = new Set(questions.map(question => question.id));
    if (Object.keys(answers).some(key => !expected.has(key))) throw new HttpError(400, '回答包含未知的问题');
    if (!skip && questions.some(question => !Object.hasOwn(answers, question.id) || !answers[question.id].some(answer => answer.trim()))) {
      throw new HttpError(400, '请回答每个问题，或选择跳过');
    }
    pending.finish(skip ? {} : answers);
  }
}
