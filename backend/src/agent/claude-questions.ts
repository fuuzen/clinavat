import type { RunServices } from './types.js';
import { unansweredNotice } from './user-input.js';

export type ClaudeAnswer = { updatedInput: Record<string, unknown> } | { reason: string };

export async function answerClaudeQuestions(services: RunServices, input: Record<string, unknown>, signal?: AbortSignal): Promise<ClaudeAnswer> {
  if (!Array.isArray(input.questions)) throw new Error('原生问题列表无效');
  const questions = input.questions.map((question: Record<string, unknown>, index: number) => ({
    id: String(index), header: String(question.header ?? ''), question: String(question.question ?? ''),
    multiSelect: question.multiSelect === true,
    options: Array.isArray(question.options) ? question.options.map((option: Record<string, unknown>) => ({
      label: String(option.label ?? ''), description: String(option.description ?? ''),
    })) : undefined,
  }));
  const outcome = await services.ask(questions, signal);
  if (outcome.status !== 'answered') return { reason: unansweredNotice(outcome) };
  return { updatedInput: { ...input, answers: Object.fromEntries(questions.map(question =>
    [question.question, (outcome.answers[question.id] ?? []).join(', ')])) } };
}
