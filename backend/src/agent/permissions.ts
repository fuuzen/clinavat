import { HttpError } from '../models.js';

export const permissionModes = ['manual', 'accept-edits', 'auto', 'full-access', 'yolo'] as const;
export type PermissionMode = typeof permissionModes[number];

export function getPermissionMode(session: { permission_mode?: string | null }): PermissionMode {
  return permissionModes.includes(session.permission_mode as PermissionMode)
    ? session.permission_mode as PermissionMode : 'manual';
}

export function validatePermissionMode(engine: 'claude' | 'codex', mode: unknown): PermissionMode {
  if (!permissionModes.includes(mode as PermissionMode)) throw new HttpError(400, '不支持的授权模式');
  if (engine === 'codex' && mode === 'accept-edits') throw new HttpError(400, 'Codex 不支持自动接受编辑模式');
  return mode as PermissionMode;
}

export function claudePermissionMode(session: { permission_mode?: string | null }) {
  const mode = getPermissionMode(session);
  if (mode === 'accept-edits') return 'acceptEdits';
  if (mode === 'full-access') return 'bypassPermissions';
  return mode === 'yolo' ? 'manual' : mode;
}
