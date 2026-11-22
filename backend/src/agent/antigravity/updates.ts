import { unansweredNotice, type UserInputOutcome, type UserInputQuestion } from '../user-input.js';

/** A tool call as agy reports it over ACP. */
export interface AcpToolCall {
  toolCallId?: string;
  name?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: { type?: string; path?: string; oldText?: string | null; newText?: string; content?: { type?: string; text?: string } }[];
}

/**
 * The tool and input in the shapes the web view knows from Claude Code, so approvals show the command or the diff:
 * commands as Bash, file changes as Write or Edit, reads as Read.
 */
export function describeToolCall(call: AcpToolCall): { tool: string; input: Record<string, unknown> } {
  const args = call.rawInput ?? {};
  if (call.name === 'run_command') return { tool: 'Bash', input: { command: args.CommandLine, description: args.toolSummary } };
  const diff = call.content?.find(item => item.type === 'diff' && typeof item.path === 'string');
  if (diff) {
    return diff.oldText === null || diff.oldText === undefined
      ? { tool: 'Write', input: { file_path: diff.path, content: diff.newText ?? '' } }
      : { tool: 'Edit', input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText ?? '' } };
  }
  if (call.kind === 'read' && typeof args.Path === 'string') return { tool: 'Read', input: { file_path: args.Path } };
  return { tool: call.name || call.title || 'tool', input: args };
}

export function toolStatus(status: unknown): string {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running';
}

export function toolOutput(call: AcpToolCall): string | undefined {
  const output = typeof call.rawOutput?.output === 'string' ? call.rawOutput.output
    : call.content?.map(item => item.content?.text).filter((text): text is string => typeof text === 'string').join('\n');
  return output ? output.slice(0, 128 * 1024) : undefined;
}

type Choice = { const?: unknown; title?: unknown };
interface SchemaField { type?: string; title?: string; description?: string; oneOf?: Choice[]; anyOf?: Choice[]; enum?: unknown[]; items?: SchemaField }

function choices(field: SchemaField): Choice[] | undefined {
  const source = field.type === 'array' ? field.items ?? {} : field;
  return source.oneOf ?? source.anyOf ?? source.enum?.map(value => ({ const: value, title: value }));
}

const choiceLabel = (choice: Choice) => String(choice.title ?? choice.const);

/**
 * agy asks through an ACP form: each question is a field whose choices carry numbered constants, with an optional
 * `<field>_other` for a free answer.
 */
export function formQuestions(schema: { properties?: Record<string, SchemaField> } | undefined): UserInputQuestion[] {
  const properties = schema?.properties ?? {};
  return Object.entries(properties).flatMap(([id, field]) => {
    if (id.endsWith('_other') && properties[id.slice(0, -'_other'.length)]) return [];
    const options = choices(field);
    return [{ id, header: 'Antigravity', question: String(field.title ?? field.description ?? id), multiSelect: field.type === 'array',
      isOther: !options || !!properties[`${id}_other`], options: options?.map(choice => ({ label: choiceLabel(choice), description: '' })) ?? null }];
  });
}

/** The form's content for the user's answers; a question nobody answered gets the notice in its free field. */
export function formContent(schema: { properties?: Record<string, SchemaField> } | undefined, questions: UserInputQuestion[],
  outcome: UserInputOutcome): Record<string, unknown> {
  const properties = schema?.properties ?? {};
  const content: Record<string, unknown> = {};
  for (const question of questions) {
    const options = choices(properties[question.id] ?? {}) ?? [];
    const answers = outcome.status === 'answered' ? outcome.answers[question.id] ?? [] : [unansweredNotice(outcome)];
    const chosen = answers.flatMap(answer => options.filter(choice => choiceLabel(choice) === answer).map(choice => choice.const));
    const free = answers.filter(answer => !options.some(choice => choiceLabel(choice) === answer));
    if (chosen.length) content[question.id] = question.multiSelect ? chosen : chosen[0];
    if (free.length) content[properties[`${question.id}_other`] ? `${question.id}_other` : question.id] = free.join(', ');
  }
  return content;
}
