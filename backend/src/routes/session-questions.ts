import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionFor, withResourceLocks, type Context } from '../context.js';
import { HttpError } from '../models.js';
import { validateAnswers, type UserInputAnswers, type UserInputQuestion } from '../agent/user-input.js';
import { messageInput, sendSessionMessage } from './session-messages.js';

interface StoredQuestion { id: string; session_id: string; questions: string; created_at: string; deferred_at: string }

const answerInput = z.object({
  answers: z.record(z.string().max(200), z.array(z.string().max(10000)).max(20)).default({}),
  skip: z.boolean().default(false),
});

/** The message that carries a kept question's answer to the agent; the user sees it in the conversation too. */
function answerMessage(questions: UserInputQuestion[], answers: UserInputAnswers, skip: boolean): string {
  if (skip) return '我跳过了你之前提出的问题，请依据已有信息继续，不要假定任何选项已获同意。';
  return ['我对你之前提出的问题的回答：', ...questions.map((question, index) =>
    `${index + 1}. ${question.question}\n   回答：${answers[question.id].map(answer => answer.trim()).filter(Boolean).join('；')}`)].join('\n');
}

export function sessionQuestionRoutes(app: FastifyInstance, context: Context) {
  const { store, agents, events } = context;
  const deferred = (sessionId: string) => store.all<StoredQuestion>(
    'SELECT * FROM deferred_questions WHERE session_id=? ORDER BY deferred_at,rowid', sessionId,
  ).map(row => ({ ...row, status: 'deferred' as const, questions: JSON.parse(row.questions) as UserInputQuestion[] }));

  app.get('/api/sessions/:id/questions', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    sessionFor(context, id, request.user.id);
    return [...deferred(id), ...agents.questions.list(id)];
  });
  app.post('/api/sessions/:id/questions/:requestId', async request => {
    const { id, requestId } = z.object({ id: z.uuid(), requestId: z.uuid() }).parse(request.params);
    sessionFor(context, id, request.user.id);
    const input = answerInput.parse(request.body);
    if (agents.questions.has(id, requestId)) {
      agents.questions.answer(id, requestId, input.answers, input.skip);
      return { ok: true };
    }
    return withResourceLocks(context, [`question:${requestId}`], async () => {
      const question = deferred(id).find(item => item.id === requestId);
      if (!question) throw new HttpError(409, '这个问题已结束，请刷新对话');
      validateAnswers(question.questions, input.answers, input.skip);
      const content = answerMessage(question.questions, input.answers, input.skip);
      if (content.length > 100000) throw new HttpError(400, '回答过长，请精简后再提交');
      const sent = await sendSessionMessage(context, request.user, id, messageInput.parse({ content }));
      store.run('DELETE FROM deferred_questions WHERE id=?', requestId);
      events.emit(request.user.id, { type: 'user-input', sessionId: id, payload: { id: requestId, status: 'answered' } });
      return { ok: true, ...sent };
    });
  });
}
