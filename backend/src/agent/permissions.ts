import { HttpError } from '../models.js';
import { engineProfiles, type AgentEngine } from './engines.js';

export const permissionModes = ['manual', 'accept-edits', 'auto', 'full-access', 'yolo'] as const;
export type PermissionMode = typeof permissionModes[number];
/** New conversations of users without their own default let the CLI's native reviewer decide. */
export const defaultPermissionMode: PermissionMode = 'auto';
const modeNames: Record<PermissionMode, string> = {
  manual: '按需审批', 'accept-edits': '自动接受编辑', auto: '自动审批', 'full-access': 'Full access', yolo: 'YOLO',
};

export function getPermissionMode(session: { permission_mode?: string | null }): PermissionMode {
  return permissionModes.includes(session.permission_mode as PermissionMode)
    ? session.permission_mode as PermissionMode : 'manual';
}

export function validatePermissionMode(engine: AgentEngine, mode: unknown): PermissionMode {
  if (!permissionModes.includes(mode as PermissionMode)) throw new HttpError(400, '不支持的授权模式');
  const profile = engineProfiles[engine];
  if (!profile.permissionModes.includes(mode as PermissionMode)) {
    throw new HttpError(400, `${profile.label} 不支持${modeNames[mode as PermissionMode]}模式`);
  }
  return mode as PermissionMode;
}

export function claudePermissionMode(session: { permission_mode?: string | null }) {
  const mode = getPermissionMode(session);
  if (mode === 'accept-edits') return 'acceptEdits';
  if (mode === 'full-access') return 'bypassPermissions';
  return mode === 'yolo' ? 'manual' : mode;
}
