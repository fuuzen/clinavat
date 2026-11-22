import { z } from 'zod';
import { agentEngines } from '../agent/engines.js';
import type { HubTool } from '../agent/types.js';
import { orchestrationLimits } from './limits.js';

const agentReference = z.string().trim().min(1).max(64).describe('The child agent\'s name, or the agentId start_agent returned.');

export const toolInputs = {
  list_agents: z.object({}),
  start_agent: z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'name: letters, digits, "-" and "_", at most 32 characters')
      .describe('A short name for the child, unique in this conversation, such as "reviewer" or "impl-api".'),
    engine: z.enum(agentEngines).describe('Which CLI the child runs.'),
    model: z.string().trim().min(1).max(200).optional().describe('Model ID from list_agents; omit for the account\'s default.'),
    effort: z.string().trim().min(1).max(32).optional().describe('Reasoning effort the model offers; omit for its default.'),
    slot: z.string().trim().min(1).max(64).optional().describe('Account slot ID from list_agents; omit to let the Hub choose.'),
    access: z.enum(['read', 'write']).default('read')
      .describe('"read" cannot modify files; "write" can. Prefer read for research and review.'),
    prompt: z.string().trim().min(1).max(100_000)
      .describe('The complete, self-contained task. The child starts with no context: include goals, constraints, file paths to read, and what to report back.'),
    notify: z.boolean().default(true).describe('Deliver the child\'s report to you as a new message when it finishes. Set false if you will wait or read it yourself.'),
  }),
  message_agent: z.object({
    agent: agentReference,
    message: z.string().trim().min(1).max(100_000),
    mode: z.enum(['queue', 'steer', 'interrupt']).default('queue')
      .describe('While the child is replying: "queue" sends after its reply, "steer" joins the running reply, "interrupt" stops it and sends now.'),
  }),
  wait_agents: z.object({
    agents: z.array(agentReference).min(1).max(8),
    timeoutSeconds: z.number().int().min(1).max(orchestrationLimits.waitSeconds).default(300),
  }),
  read_agent: z.object({
    agent: agentReference,
    turns: z.number().int().min(1).max(5).default(1).describe('How many of the most recent turns to read.'),
    includeTools: z.boolean().default(false).describe('Also list the tool calls and the files they changed.'),
  }),
  stop_agent: z.object({ agent: agentReference }),
};

export type ToolName = keyof typeof toolInputs;

const descriptions: Record<ToolName, string> = {
  list_agents: 'Lists the CLIs, account slots and models you can start child agents with, the children of this conversation with their state, and the current limits.',
  start_agent: 'Starts a child agent in a new conversation of this project and sends it its first task. Returns at once; when the child finishes, its report arrives as a new message unless notify is false.',
  message_agent: 'Sends another message to a child agent you started; its next report arrives like the first.',
  wait_agents: 'Waits until the given child agents finish their current tasks or the timeout passes, and returns their reports. Use only when you need the results before going on in this turn; those reports then do not arrive as a new message.',
  read_agent: 'Reads a child agent\'s most recent turns: the tasks it received, its final replies and, if asked, its tool calls.',
  stop_agent: 'Stops what a child agent is doing; the conversation stays and can be messaged again.',
};

export const hubTools: HubTool[] = Object.entries(toolInputs).map(([name, schema]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return { name, description: descriptions[name as ToolName], inputSchema };
});

export const isToolName = (name: string): name is ToolName => Object.hasOwn(toolInputs, name);
