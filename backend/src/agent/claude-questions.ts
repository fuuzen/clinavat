import type { RunServices } from './types.js';

export async function answerClaudeQuestions(services: RunServices, input: Record<string, unknown>, signal?: AbortSignal) {
  if (!Array.isArray(input.questions)) throw new Error('原生问题列表无效');
  const questions = input.questions.map((question: Record<string, unknown>, index: number) => ({
    id: String(index), header: String(question.header ?? ''), question: String(question.question ?? ''),
    multiSelect: question.multiSelect === true,
    options: Array.isArray(question.options) ? question.options.map((option: Record<string, unknown>) => ({
      label: String(option.label ?? ''), description: String(option.description ?? ''),
    })) : undefined,
  }));
  const answers = await services.ask(questions, signal);
  if (!answers || !Object.keys(answers).length) return null;
  return { ...input, answers: Object.fromEntries(questions.map(question =>
    [question.question, (answers[question.id] ?? []).join(', ')])) };
}
