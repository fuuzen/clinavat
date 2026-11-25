import { z } from 'zod';
import { agentEngines } from '../agent/engines.js';
import type { HubTool } from '../agent/types.js';
import { workItemStatuses } from './board.js';
import { orchestrationConstants } from './limits.js';
import { memoryKeySchema } from './memory.js';
import { inspectInput } from './inspect.js';

const agentReference = z.string().trim().min(1).max(64).describe('The child agent\'s name, or the agentId start_agent returned.');
const wave = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'wave: letters, digits, "-" and "_", at most 32 characters').optional()
  .describe('Optional batch barrier ID (e.g. "p1-impl"). Normal completed reports in the same wave wait until all running tasks of that wave finish and arrive together in one message; errors and interruptions penetrate immediately.');

export const toolInputs = {
  list_agents: z.object({
    refreshUsage: z.array(z.string().trim().min(1).max(64)).max(32).optional()
      .describe('Optional list of slot IDs to probe for fresh quota usage (e.g. ["claude-1", "codex-1"]), or ["all"] to probe all probeable slots you can access. Prefer explicit slot IDs to avoid waking idle slot VMs; subject to maintenance mode, concurrency and 15s per-slot throttle.'),
  }),
  inspect: inspectInput,
  start_agent: z.object({
    wave,
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'name: letters, digits, "-" and "_", at most 32 characters')
      .describe('A short name for the child, unique in this conversation, such as "reviewer" or "impl-api".'),
    profile: z.string().trim().min(1).max(24).optional()
      .describe('A profile from the user\'s roster or built-in specialists ("explorer", "coder", "verifier") in list_agents; sets default CLI, account, model, access and role, and explicit fields override it.'),
    engine: z.enum(agentEngines).optional().describe('Which CLI the child runs; required without a profile.'),
    model: z.string().trim().min(1).max(200).optional().describe('Model ID from list_agents; omit for the account\'s default.'),
    effort: z.string().trim().min(1).max(32).optional().describe('Reasoning effort the model offers; omit for its default.'),
    slot: z.string().trim().min(1).max(64).optional().describe('Account slot ID from list_agents; omit to let the Hub choose.'),
    directory: z.string().trim().max(1024).optional()
      .describe('Project-relative directory the child works in; it may change only files inside it but can read the whole project. Omit for the project root.'),
    isolation: z.enum(['worktree', 'shared']).optional()
      .describe('For writing children. "worktree" (default) gives the child its own Git worktree and branch, so parallel children never overwrite each other; you merge its branch afterwards. "shared" works directly in the project directory. Ignored for read access.'),
    access: z.enum(['read', 'write']).optional()
      .describe('"read" (the default, unless the profile says otherwise) cannot modify files; "write" can. Prefer read for research and review.'),
    prompt: z.string().trim().min(1).max(100_000)
      .describe('The complete, self-contained task. The child starts with no context: include goals, constraints, file paths to read, and what to report back.'),
    task: z.string().trim().min(1).max(64).optional()
      .describe('Optional task code from task_board (such as "T1") to link to this child and mark in_progress.'),
    ephemeral: z.boolean().default(false)
      .describe('Automatically archive this child conversation once its work is delivered (and merged or discarded if using a worktree). Recommended for one-off explorers, verifiers and scoped tasks.'),
    notify: z.boolean().default(true).describe('Deliver the child\'s report to you as a new message when it finishes. Set false if you will wait or read it yourself.'),
  }),
  message_agent: z.object({
    wave,
    agent: agentReference,
    task: z.string().trim().min(1).max(64).optional()
      .describe('Task board code for this follow-up. Omit to reuse the child’s current assignment.'),
    message: z.string().trim().min(1).max(100_000),
    mode: z.enum(['queue', 'steer', 'interrupt']).default('queue')
      .describe('While the child is replying: "queue" sends after its reply, "steer" joins the running reply, "interrupt" stops it and sends now.'),
  }),
  wait_agents: z.object({
    agents: z.array(agentReference).min(1).max(8),
    timeoutSeconds: z.number().int().min(1).max(orchestrationConstants.waitSeconds).default(300),
  }),
  read_agent: z.object({
    agent: agentReference,
    turns: z.number().int().min(1).max(5).default(1).describe('How many of the most recent turns to read.'),
    includeTools: z.boolean().default(false).describe('Also list the tool calls and the files they changed.'),
  }),
  stop_agent: z.object({ agent: agentReference }),
  merge_agent: z.object({
    agent: agentReference,
    mode: z.enum(['merge', 'squash']).default('merge').describe('"merge" keeps the child\'s commits; "squash" makes them one commit.'),
    onConflict: z.enum(['abort', 'leave']).default('abort')
      .describe('"abort" leaves the project as it was and lists the conflicting files; "leave" keeps the conflict markers in the project for you to resolve and commit.'),
    archive: z.boolean().optional()
      .describe('Archive the child conversation after a successful merge; defaults to true for ephemeral children.'),
  }),
  discard_agent: z.object({
    agent: agentReference,
    archive: z.boolean().optional()
      .describe('Archive the child conversation after discarding its worktree; defaults to true for ephemeral children.'),
  }),
  archive_agent: z.object({
    agents: z.array(agentReference).min(1).max(16)
      .describe('Completed child agents (with no unmerged worktree changes) to archive so only active workers stay in view.'),
  }),
  task_board: z.object({
    action: z.enum(['list', 'add', 'update'])
      .describe('"list" reads all tasks on the board; "add" appends new tasks; "update" modifies status, assignee, acceptance or summary of existing tasks.'),
    tasks: z.array(z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(4000).optional(),
      acceptance: z.string().trim().max(2000).optional().describe('Concrete acceptance or verification criteria.'),
      assignedAgent: z.string().trim().max(64).optional().describe('Child agent name assigned to this task, if already chosen.'),
      dependsOn: z.array(z.string().trim().min(1).max(32)).max(16).optional().describe('Task codes (such as "T1") that must finish first.'),
    })).min(1).max(20).optional().describe('Required when action is "add".'),
    updates: z.array(z.object({
      task: z.string().trim().min(1).max(64).describe('Task code such as "T1", or task ID.'),
      title: z.string().trim().min(1).max(200).optional(),
      status: z.enum(workItemStatuses).optional(),
      assignedAgent: z.string().trim().max(64).nullable().optional(),
      acceptance: z.string().trim().max(2000).nullable().optional(),
      summary: z.string().trim().max(4000).nullable().optional().describe('Concise outcome, verification result, or blocker note.'),
    })).min(1).max(20).optional().describe('Required when action is "update".'),
  }),
  start_discussion: z.object({
    topic: z.string().trim().min(1).max(20_000)
      .describe('The question or decision to discuss; for a review, what to review, such as the uncommitted changes, a branch or some files.'),
    format: z.enum(['council', 'debate', 'review']).describe('"council": everyone answers independently, then critiques and ranks the others\' anonymous answers. '
      + '"debate": participants argue from given positions over several rounds until they agree. "review": everyone reviews the same work and lists problems by severity.'),
    participants: z.array(z.object({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/, 'participant name: letters, digits, "-" and "_", at most 24 characters'),
      profile: z.string().trim().min(1).max(24).optional().describe('An agent from the user\'s roster; participants stay read-only.'),
      engine: z.enum(agentEngines).optional().describe('Required without a profile.'),
      model: z.string().trim().min(1).max(200).optional(),
      effort: z.string().trim().min(1).max(32).optional(),
      slot: z.string().trim().min(1).max(64).optional(),
      stance: z.string().trim().max(500).optional().describe('Debate only: the position or perspective this participant argues from.'),
    })).min(1).max(8).describe('Prefer different vendors and models: the point is independent views.'),
    rounds: z.number().int().min(1).max(10).optional().describe('Debate only: the most rounds; the administrator\'s limit applies.'),
    directory: z.string().trim().max(1024).optional().describe('Project-relative directory the participants start in.'),
  }),
  stop_discussion: z.object({ discussion: z.uuid() }),
  read_discussion: z.object({
    discussion: z.string().trim().min(1).max(64).describe('The discussion ID from <clinavat_discussion>, or "latest".'),
    round: z.number().int().min(1).max(10).optional().describe('Read only this round; omit for all rounds.'),
    participant: z.string().trim().min(1).max(64).optional().describe('Read only this participant\'s statements (name with or without d<N>- prefix).'),
  }),
  memory: z.object({
    action: z.enum(['list', 'read', 'write', 'delete'])
      .describe('"list" lists all project memory keys and contents; "read" reads one key; "write" creates or replaces a key; "delete" removes a key.'),
    key: memoryKeySchema.optional()
      .describe('Memory topic key such as "architecture", "conventions", "decisions", "preferences", or "environment". Required for read, write and delete.'),
    content: z.string().trim().min(1).max(4000).optional()
      .describe('Concise, durable Markdown note to store under key. Required when action is "write".'),
  }),
};

export type ToolName = keyof typeof toolInputs;

const descriptions: Record<ToolName, string> = {
  list_agents: 'Lists the CLIs, account slots (with quota usage, reset countdowns and VM exclusivity hints) and models you can start child agents with, the children of this conversation with their slot/model/state, and the current limits. Pass refreshUsage with specific slot IDs (or ["all"]) to probe fresh quota on demand.',
  inspect: 'Lists a bounded tree of visible project paths or reads a permitted project text file within the current Super Agent reading mode and turn budget.',
  start_agent: 'Starts a child agent in a new conversation of this project and sends it its first task. Returns at once; when the child finishes, its report arrives as a new message unless notify is false.',
  message_agent: 'Sends another message to a child agent you started; its next report arrives like the first.',
  wait_agents: 'Waits until the given child agents finish their current tasks or the timeout passes, and returns their reports. Use only when you need the results before going on in this turn; those reports then do not arrive as a new message.',
  read_agent: 'Reads a child agent\'s most recent turns: the tasks it received, its final replies and, if asked, its tool calls.',
  stop_agent: 'Stops what a child agent is doing; the conversation stays and can be messaged again.',
  merge_agent: 'Merges the branch of a child agent that worked in its own worktree into the project, then removes its worktree and branch. The child must have finished.',
  discard_agent: 'Throws away the branch and worktree of a child agent that worked in its own worktree, or cleans them up after a conflict you resolved yourself.',
  archive_agent: 'Archives finished child agent conversations so completed workers retire cleanly from the active panel; read_agent still reads archived children.',
  task_board: 'Reads or updates the persistent task board (T1, T2, ...) for decomposing multi-step work, tracking child assignments, verification status and outcomes across turns.',
  start_discussion: 'Starts a discussion among read-only child agents, run by the Hub round by round. Returns at once; when it ends, its record arrives as a new message for you to synthesize. Use it for open questions, design choices, trade-offs and cross-vendor reviews.',
  stop_discussion: 'Stops a discussion and its participants; no record arrives.',
  read_discussion: 'Reads full statements of a discussion by ID (or "latest"), optionally filtered by round or participant.',
  memory: 'Reads or updates persistent project-level memory notes (architecture, conventions, key decisions, user preferences) that survive context compaction and session rollover.',
};

export const hubTools: HubTool[] = Object.entries(toolInputs).map(([name, schema]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return { name, description: descriptions[name as ToolName], inputSchema };
});

export const isToolName = (name: string): name is ToolName => Object.hasOwn(toolInputs, name);
