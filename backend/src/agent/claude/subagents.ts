/**
 * Tells the frames subagents produce from the main conversation's. A subagent's text and partial output never
 * become the reply; its tool calls are shown under the name of the Agent call that launched it.
 */
export class ClaudeSubagents {
  private names = new Map<string, string>();

  launched(toolUseId: string, input: unknown): void {
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const name = [args.description, args.subagent_type].find(value => typeof value === 'string' && value.trim());
    this.names.set(toolUseId, typeof name === 'string' ? name.trim().slice(0, 80) : '子智能体');
  }

  /** The name of the subagent that produced the frame; undefined for the main conversation. */
  source(event: Record<string, any>): string | undefined {
    const parent = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : '';
    if (!parent && !(typeof event.agent_id === 'string' && event.agent_id)) return undefined;
    return this.names.get(parent)
      ?? (typeof event.task_description === 'string' && event.task_description ? event.task_description.slice(0, 80) : '子智能体');
  }
}
