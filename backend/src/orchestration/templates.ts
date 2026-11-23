import type { AgentEngine } from '../agent/engines.js';

export interface BuiltInProfile {
  name: string;
  access: 'read' | 'write';
  preferCrossEngine?: boolean;
  summary: string;
  instructions: string;
}

/** Built-in specialist profiles available to any master agent unless overridden by a user roster entry of the same name. */
export const builtInProfiles: readonly BuiltInProfile[] = [
  {
    name: 'explorer',
    access: 'read',
    summary: '只读代码调研与架构定位',
    instructions: [
      'Role: Codebase explorer (read-only).',
      'Investigate the requested area thoroughly without modifying any files.',
      'Return a concise, structured report: 1) Summary & direct answer, 2) Key files/symbols with exact line numbers, 3) Constraints, edge cases or risks.',
    ].join('\n'),
  },
  {
    name: 'coder',
    access: 'write',
    summary: '专注编码实现与局部验证（默认 worktree 隔离）',
    instructions: [
      'Role: Implementation engineer.',
      'Implement the requested changes cleanly within the assigned scope and follow project conventions.',
      'Run relevant local checks/builds/typechecks before finishing when possible.',
      'Return a concise, structured report: 1) Summary of changes, 2) Changed files with key symbols, 3) Verification commands and outcomes, 4) Unresolved caveats or follow-ups.',
    ].join('\n'),
  },
  {
    name: 'verifier',
    access: 'read',
    preferCrossEngine: true,
    summary: '独立只读审查与构建/测试验收（优先异构模型）',
    instructions: [
      'Role: Independent code reviewer & verifier (read-only).',
      'Inspect the target changes critically and run verification commands (typecheck, build, lint, runtime checks) without modifying project files.',
      'Return a concise, structured report: 1) Verdict (PASS / NEEDS FIX), 2) Findings grouped by severity (Blocker / High / Medium / Low) with file paths and line numbers, 3) Verification commands run and exact outcomes.',
    ].join('\n'),
  },
];

export function pickBuiltInEngine(
  masterEngine: AgentEngine,
  availableEngines: readonly AgentEngine[],
  preferCrossEngine?: boolean,
): AgentEngine {
  if (preferCrossEngine) {
    const other = availableEngines.find(engine => engine !== masterEngine);
    if (other) return other;
  }
  if (availableEngines.includes(masterEngine)) return masterEngine;
  return availableEngines[0] ?? masterEngine;
}

export function resolveBuiltInProfile(
  name: string,
  masterEngine: AgentEngine,
  availableEngines: readonly AgentEngine[],
) {
  const template = builtInProfiles.find(item => item.name === name);
  if (!template) return undefined;
  return {
    ...template,
    engine: pickBuiltInEngine(masterEngine, availableEngines, template.preferCrossEngine),
  };
}
