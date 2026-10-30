import { HttpError } from '../models.js';

export const agentModes = ['normal', 'plan'] as const;
export type AgentMode = typeof agentModes[number];
export const rolePresets = ['default', 'reviewer', 'architect'] as const;
export type RolePreset = typeof rolePresets[number];

export function validateSessionSettings(engine: 'claude' | 'codex', agentMode: unknown, rolePreset: unknown) {
  if (!agentModes.includes(agentMode as AgentMode)) throw new HttpError(400, '不支持的工作模式');
  if (!rolePresets.includes(rolePreset as RolePreset)) throw new HttpError(400, '不支持的角色预设');
  if (engine !== 'codex' && rolePreset !== 'default') throw new HttpError(400, '角色预设仅适用于 Codex');
  return { agentMode: agentMode as AgentMode, rolePreset: rolePreset as RolePreset };
}

export function roleInstructions(role: string | null | undefined): string {
  if (role === 'reviewer') return '\nRole preset: Code reviewer. Prioritize concrete correctness, security, and regression findings with file references. Review without changing files unless the user explicitly requests fixes. State when no actionable findings remain.';
  if (role === 'architect') return '\nRole preset: Software architect. Analyze existing boundaries and constraints, explain design tradeoffs, and propose a practical implementation plan. Ask about consequential unknowns. Implement changes when the user requests implementation.';
  return '';
}
