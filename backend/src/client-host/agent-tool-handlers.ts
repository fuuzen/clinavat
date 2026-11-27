import { getPermissionMode } from '../agent/permissions.js';
import type { AgentWorkspaceBridge, HubToolResult, RunServices } from '../agent/types.js';
import {
  assertSafeGlobPattern, buildUnifiedDiff, clientToolInputs, effectiveClientRoot, extractPatchPaths,
  formatApprovalCommand, isClientDirectReadTool, resolveClientToolPath, validateCommandEnv, type ClientDirectToolName,
} from './agent-tools.js';
import { isProtectedInternalSegment } from './path-utils.js';

const DEFAULT_READ_LINES = 400;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_FETCH_BYTES = 256 * 1024;
const MAX_LINE_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_PREVIEW_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 128 * 1024;
const MAX_TRACKED_TASKS = 10_000;
const utf8Lossy = new TextDecoder('utf-8', { fatal: false });

/** Tracks background task ownership (`taskId -> sessionId`) with LRU eviction for strict fail-closed isolation. */
const taskOwners = new Map<string, string>();

function recordTaskOwner(taskId: string, sessionId: string): void {
  if (taskOwners.has(taskId)) taskOwners.delete(taskId);
  else if (taskOwners.size >= MAX_TRACKED_TASKS) {
    const oldest = taskOwners.keys().next().value;
    if (oldest) taskOwners.delete(oldest);
  }
  taskOwners.set(taskId, sessionId);
}

function isOwnedTask(taskId: string, sessionId: string): boolean {
  const owner = taskOwners.get(taskId);
  if (owner !== sessionId) return false;
  taskOwners.delete(taskId);
  taskOwners.set(taskId, owner);
  return true;
}

function requireBridge(services: RunServices): { hostId: string; bridge: AgentWorkspaceBridge } {
  const hostId = services.context.project.dev_host_id || services.context.host?.id;
  if (!hostId) throw new Error('项目缺少客户端设备标识');
  const bridge = services.config.workspaces;
  if (!bridge) throw new Error('客户端工作区通道尚未就绪');
  return { hostId, bridge };
}

const hasWriteAccess = (services: RunServices) => services.context.session.agent_access !== 'read';
const truncateText = (text: string, limit = MAX_OUTPUT_CHARS) =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[输出已截断，原长 ${text.length} 字符]`;
const containsProtectedSegment = (relPath: string) =>
  relPath.replace(/\\/g, '/').split('/').some(segment => segment && isProtectedInternalSegment(segment));

async function approveClientAction(
  services: RunServices, tool: ClientDirectToolName, input: Record<string, unknown>, kind: 'edit' | 'exec', signal: AbortSignal,
): Promise<void> {
  const planning = services.context.session.agent_mode === 'plan';
  if (planning && kind === 'edit') throw new Error('Plan 模式下不能修改项目文件；请先完成方案并待用户切换到 Normal 模式后再执行。');
  const mode = getPermissionMode(services.context.session);
  if (!planning && (mode === 'full-access' || (kind === 'edit' && mode === 'accept-edits'))) return;
  const decision = await services.approve(`clinavat.${tool}`, input, signal);
  if (decision.decision !== 'allow') throw new Error(decision.reason || '用户拒绝了此客户端操作');
}

async function handleReadFile(services: RunServices, rawArgs: unknown): Promise<HubToolResult> {
  const input = clientToolInputs.client_read_file.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const target = resolveClientToolPath(services.context, input.path);
  const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
  const baseOffset = input.byteOffset ?? 0;

  if (input.byteOffset !== undefined && input.offset === undefined && input.limit === undefined) {
    const slice = await bridge.readSlice(hostId, target.root, target.relPath, baseOffset, Math.min(MAX_FETCH_BYTES, maxBytes));
    if (slice.isBinary) return { text: `文件 ${target.relPath} 为二进制文件（${slice.size} 字节），无法按文本读取。`, isError: true };
    const outBuf = slice.buffer.subarray(0, maxBytes);
    const nextByte = baseOffset + outBuf.length;
    const note = nextByte < slice.size
      ? `\n\n[Truncated: returned bytes ${baseOffset}-${nextByte} of ${slice.size}; pass byteOffset=${nextByte} to continue.]` : '';
    return { text: utf8Lossy.decode(outBuf) + note };
  }

  const startLine = Math.max(1, input.offset ?? 1);
  const limit = input.limit ?? DEFAULT_READ_LINES;
  const rendered: string[] = [];
  let cursor = baseOffset, scannedBytes = 0, fileSize = 0, currentLine = 1;
  let carryBuf: Buffer = Buffer.alloc(0), carryStartByte = baseOffset, lastEndByte = baseOffset, usedBytes = 0;
  let byteClipped = false, hasMoreLines = false, reachedEof = false;

  const consumeLine = (lineBuf: Buffer, endByte: number): boolean => {
    if (currentLine >= startLine) {
      if (rendered.length >= limit) { hasMoreLines = true; return false; }
      const lineText = `${currentLine}: ${utf8Lossy.decode(lineBuf)}`;
      const lineBytes = Buffer.byteLength(lineText, 'utf8') + 1;
      if (rendered.length > 0 && usedBytes + lineBytes > maxBytes) { byteClipped = true; hasMoreLines = true; return false; }
      rendered.push(lineText);
      usedBytes += lineBytes;
      lastEndByte = endByte;
    }
    currentLine++;
    return true;
  };

  while (scannedBytes < MAX_LINE_SCAN_BYTES) {
    const slice = await bridge.readSlice(hostId, target.root, target.relPath, cursor, Math.min(MAX_FETCH_BYTES, MAX_LINE_SCAN_BYTES - scannedBytes));
    if (slice.isBinary) return { text: `文件 ${target.relPath} 为二进制文件（${slice.size} 字节），无法按文本读取。`, isError: true };
    fileSize = slice.size;
    cursor += slice.buffer.length;
    scannedBytes += slice.buffer.length;
    reachedEof = cursor >= fileSize || slice.buffer.length === 0;

    const combined = carryBuf.length ? Buffer.concat([carryBuf, slice.buffer]) : slice.buffer;
    let pos = 0, stopped = false;
    while (pos < combined.length) {
      const nl = combined.indexOf(0x0a, pos);
      if (nl === -1) break;
      if (!consumeLine(combined.subarray(pos, nl), carryStartByte + nl + 1)) { stopped = true; break; }
      pos = nl + 1;
    }
    if (stopped) break;
    if (reachedEof) {
      if (pos < combined.length) consumeLine(combined.subarray(pos), carryStartByte + combined.length);
      carryBuf = Buffer.alloc(0);
      carryStartByte = cursor;
      break;
    }
    carryBuf = Buffer.from(combined.subarray(pos));
    carryStartByte += pos;
    if (rendered.length >= limit) { hasMoreLines = true; break; }
  }

  if (!rendered.length) {
    if (!reachedEof) {
      // Align resume offset to the start of the incomplete trailing line so the next read never splits mid-line.
      const resumeByte = carryStartByte > baseOffset ? carryStartByte : cursor;
      const scannedLines = Math.max(0, currentLine - 1);
      const scanDesc = baseOffset > 0 ? `scanned ${scannedBytes} bytes from byteOffset=${baseOffset}` : `scanned first ${scannedBytes} bytes`;
      if (scannedLines === 0) {
        const skipDesc = baseOffset > 0 ? `skip past this ${scannedBytes}-byte window` : `skip past the first ${scannedBytes} bytes`;
        return { text: `[Scan limit reached: ${scanDesc} of ${fileSize} total bytes without encountering a newline (single line exceeds 2 MiB). Pass byteOffset=${baseOffset} (without offset/limit) to read raw bytes from byteOffset=${baseOffset}, or byteOffset=${resumeByte} to ${skipDesc}.]` };
      }
      return { text: `[Scan limit reached: ${scanDesc} (lines 1-${scannedLines}) of ${fileSize} total bytes without reaching offset=${startLine}. Pass byteOffset=${resumeByte} (and optional maxBytes) to read further into this file.]` };
    }
    if (fileSize === 0 && startLine === 1) return { text: '' };
    return { text: `[End of file: file has ${Math.max(0, currentLine - 1)} lines (${fileSize} bytes); requested offset=${startLine} is past EOF.]` };
  }
  const endLine = startLine + rendered.length - 1;
  if (!(byteClipped || hasMoreLines || lastEndByte < fileSize)) return { text: rendered.join('\n') };
  if (input.byteOffset !== undefined) {
    return { text: `${rendered.join('\n')}\n\n[Truncated: showing lines ${startLine}-${endLine} from byteOffset=${baseOffset} (${usedBytes} bytes of ${fileSize} total bytes). Pass byteOffset=${lastEndByte} to continue.]` };
  }
  const hint = !reachedEof && scannedBytes >= MAX_LINE_SCAN_BYTES
    ? `Pass byteOffset=${lastEndByte} to continue reading beyond the 2 MiB line-scan window.`
    : `Pass offset=${endLine + 1} or byteOffset=${lastEndByte} to read more.`;
  return { text: `${rendered.join('\n')}\n\n[Truncated: showing lines ${startLine}-${endLine} (${usedBytes} bytes of ${fileSize} total bytes). ${hint}]` };
}

async function handleListDir(services: RunServices, rawArgs: unknown): Promise<HubToolResult> {
  const input = clientToolInputs.client_list_dir.parse(rawArgs ?? {});
  const { hostId, bridge } = requireBridge(services);
  const target = resolveClientToolPath(services.context, input.path, { allowEmpty: true });
  const listing = await bridge.listFiles(hostId, target.root, target.relPath);
  const entries = listing.entries.filter(entry => !containsProtectedSegment(entry.path));
  const lines = entries.map(entry => entry.type === 'directory'
    ? `[dir]  ${entry.name}/` : `[file] ${entry.name}${entry.size !== undefined ? ` (${entry.size} B)` : ''}`);
  return { text: JSON.stringify({ path: listing.path || '.', total: entries.length, entries, summary: lines.join('\n') }, null, 1) };
}

async function handleGlob(services: RunServices, rawArgs: unknown): Promise<HubToolResult> {
  const input = clientToolInputs.client_glob.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const target = resolveClientToolPath(services.context, input.path, { allowEmpty: true });
  assertSafeGlobPattern(input.pattern, target.platform);
  const result = await bridge.glob(hostId, {
    root: target.root, pattern: input.pattern, cwd: target.relPath || undefined, maxResults: input.maxResults ?? 200,
  });
  return { text: truncateText(JSON.stringify({ matches: result.matches.filter(item => !containsProtectedSegment(item)), truncated: Boolean(result.truncated) }, null, 1)) };
}

async function handleGrep(services: RunServices, rawArgs: unknown): Promise<HubToolResult> {
  const input = clientToolInputs.client_grep.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const target = resolveClientToolPath(services.context, input.path, { allowEmpty: true });
  if (input.glob) assertSafeGlobPattern(input.glob, target.platform);
  const result = await bridge.grep(hostId, {
    root: target.root, pattern: input.pattern, path: target.relPath || undefined,
    glob: input.glob, caseInsensitive: input.caseInsensitive, maxResults: input.maxResults ?? 100,
  });
  return { text: truncateText(JSON.stringify({ matches: result.matches.filter(match => !containsProtectedSegment(match.path)), truncated: Boolean(result.truncated) }, null, 1)) };
}

async function handleWriteFile(services: RunServices, rawArgs: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const input = clientToolInputs.client_write_file.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const target = resolveClientToolPath(services.context, input.path, { forWrite: true });
  let before: string | null = null;
  const meta = await bridge.stat(hostId, target.root, target.relPath).catch(() => ({ exists: false } as const));
  if (meta.exists && meta.kind === 'file' && !meta.isSymlink) {
    const existing = await bridge.readSlice(hostId, target.root, target.relPath, 0, MAX_EDIT_PREVIEW_BYTES);
    before = existing.isBinary ? '[binary file]' : existing.buffer.toString('utf8');
  }
  await approveClientAction(services, 'client_write_file', {
    path: target.relPath, clientPath: target.clientPath, existed: before !== null,
    bytes: Buffer.byteLength(input.content, 'utf8'), diff: buildUnifiedDiff(target.relPath, before, input.content),
  }, 'edit', signal);
  const written = await bridge.writeFile(hostId, {
    root: target.root, path: target.relPath,
    contentBase64: Buffer.from(input.content, 'utf8').toString('base64'),
    createDirs: input.createDirs ?? true, commit: true,
  });
  return { text: JSON.stringify({ path: target.relPath, size: written.size, mtimeMs: written.mtimeMs }) };
}

async function handleEditFile(services: RunServices, rawArgs: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const input = clientToolInputs.client_edit_file.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const target = resolveClientToolPath(services.context, input.path, { forWrite: true });
  const existing = await bridge.readSlice(hostId, target.root, target.relPath, 0, MAX_EDIT_PREVIEW_BYTES);
  if (existing.isBinary) throw new Error(`文件 ${target.relPath} 为二进制文件，无法使用文本编辑`);
  if (existing.size > MAX_EDIT_PREVIEW_BYTES) throw new Error(`文件 ${target.relPath} 超过 1 MiB 编辑预览上限`);
  const before = existing.buffer.toString('utf8');
  const firstIdx = before.indexOf(input.oldText);
  if (firstIdx < 0) throw new Error(`未在 ${target.relPath} 中找到要替换的 oldText`);
  if (!input.replaceAll && before.indexOf(input.oldText, firstIdx + input.oldText.length) >= 0) {
    throw new Error(`oldText 在 ${target.relPath} 中出现多次；请提供更长上下文或设置 replaceAll=true`);
  }
  const after = input.replaceAll
    ? before.split(input.oldText).join(input.newText)
    : before.slice(0, firstIdx) + input.newText + before.slice(firstIdx + input.oldText.length);
  await approveClientAction(services, 'client_edit_file', {
    path: target.relPath, clientPath: target.clientPath, replaceAll: Boolean(input.replaceAll), diff: buildUnifiedDiff(target.relPath, before, after),
  }, 'edit', signal);
  const edited = await bridge.editFile(hostId, {
    root: target.root, path: target.relPath, oldText: input.oldText, newText: input.newText, replaceAll: input.replaceAll,
  });
  return { text: JSON.stringify({ path: target.relPath, replacements: edited.replacements, size: edited.size }) };
}

async function handleApplyPatch(services: RunServices, rawArgs: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const input = clientToolInputs.client_apply_patch.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const { root } = effectiveClientRoot(services.context);
  const declared = extractPatchPaths(input.patch).map(p => resolveClientToolPath(services.context, p, { forWrite: true }).relPath);
  if (!declared.length) throw new Error('补丁未声明任何受影响的文件路径');
  const preview = await bridge.applyPatch(hostId, { root, patch: input.patch, dryRun: true });
  if (preview.ok === false) throw new Error(preview.error || '补丁 dry-run 校验失败');
  const validatedPreviewFiles = preview.files.map(file => resolveClientToolPath(services.context, file, { forWrite: true }).relPath);
  const approvalFiles = [...new Set([...declared, ...validatedPreviewFiles])];
  const diff = preview.diff ? truncateText(preview.diff, 32 * 1024) : input.patch.slice(0, 32 * 1024);
  await approveClientAction(services, 'client_apply_patch', { files: approvalFiles, hunks: preview.hunks, diff }, 'edit', signal);
  const applied = await bridge.applyPatch(hostId, { root, patch: input.patch, dryRun: false });
  if (applied.ok === false) throw new Error(applied.error || '补丁应用失败');
  return { text: JSON.stringify({ ok: true, files: applied.files.length ? applied.files : approvalFiles, hunks: applied.hunks ?? preview.hunks }) };
}

async function handleExecCommand(services: RunServices, rawArgs: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const input = clientToolInputs.client_exec_command.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const resolvedCwd = resolveClientToolPath(services.context, input.cwd, { allowEmpty: true });
  const env = validateCommandEnv(input.env);
  await approveClientAction(services, 'client_exec_command', {
    command: formatApprovalCommand(input.command, env),
    cwd: resolvedCwd.clientPath,
    ...(env ? { env } : {}),
    ...(input.waitMsBeforeAsync !== undefined ? { waitMsBeforeAsync: input.waitMsBeforeAsync } : {}),
    ...(input.background ? { background: true } : {}),
    ...(input.shell ? { shell: input.shell } : {}),
  }, 'exec', signal);
  const result = await bridge.execCommand(hostId, {
    cwd: resolvedCwd.clientPath, command: input.command, shell: input.shell, env,
    background: input.background, waitMs: input.waitMsBeforeAsync, sessionId: services.context.session.id,
  });
  if (result.backgroundTaskId) recordTaskOwner(result.backgroundTaskId, services.context.session.id);
  const parts = [`exitCode: ${result.exitCode}`];
  if (result.timedOut) parts.push('timedOut: true');
  if (result.backgroundTaskId) parts.push(`backgroundTaskId: ${result.backgroundTaskId}`);
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return { text: truncateText(parts.join('\n')), isError: result.exitCode !== 0 && !result.backgroundTaskId };
}

async function handleManageTask(services: RunServices, rawArgs: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const input = clientToolInputs.client_manage_task.parse(rawArgs);
  const { hostId, bridge } = requireBridge(services);
  const sessionId = services.context.session.id;
  if ((input.action === 'send_input' || input.action === 'kill') && !hasWriteAccess(services)) {
    throw new Error('只读子智能体不能向后台任务发送输入或终止任务');
  }
  if (input.action !== 'list') {
    if (!input.taskId) throw new Error(`client_manage_task(action="${input.action}") 需要指定 taskId`);
    if (!isOwnedTask(input.taskId, sessionId)) throw new Error('无权访问未知或其他会话的后台任务');
  }
  if (input.action === 'send_input') {
    if (input.input === undefined) throw new Error('client_manage_task(action="send_input") 需要提供 input');
    await approveClientAction(services, 'client_manage_task', {
      command: `[task:${input.taskId} stdin] ${input.input}`, action: 'send_input', taskId: input.taskId, input: input.input,
    }, 'exec', signal);
  }
  const result = await bridge.manageTask(hostId, {
    sessionId, action: input.action,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
  });
  if (input.action === 'list' && result && typeof result === 'object' && Array.isArray((result as { tasks?: unknown }).tasks)) {
    const filtered = ((result as { tasks: Array<{ taskId?: string; id?: string; sessionId?: string }> }).tasks).filter(task => {
      if (task.sessionId && task.sessionId !== sessionId) return false;
      const tid = task.taskId ?? task.id;
      return typeof tid === 'string' && tid.length > 0 && isOwnedTask(tid, sessionId);
    });
    return { text: truncateText(JSON.stringify({ ...(result as Record<string, unknown>), tasks: filtered }, null, 1)) };
  }
  return { text: truncateText(typeof result === 'string' ? result : JSON.stringify(result ?? {}, null, 1)) };
}

/** Dispatches a validated `client_*` tool call with read-only enforcement and error isolation. */
export async function callClientDirectTool(
  services: RunServices, tool: ClientDirectToolName, args: unknown, signal: AbortSignal,
): Promise<HubToolResult> {
  if (!isClientDirectReadTool(tool) && !hasWriteAccess(services)) {
    return { text: `只读子智能体不能调用写/执行工具 ${tool}`, isError: true };
  }
  try {
    switch (tool) {
      case 'client_read_file': return await handleReadFile(services, args);
      case 'client_list_dir': return await handleListDir(services, args);
      case 'client_glob': return await handleGlob(services, args);
      case 'client_grep': return await handleGrep(services, args);
      case 'client_write_file': return await handleWriteFile(services, args, signal);
      case 'client_edit_file': return await handleEditFile(services, args, signal);
      case 'client_apply_patch': return await handleApplyPatch(services, args, signal);
      case 'client_exec_command': return await handleExecCommand(services, args, signal);
      case 'client_manage_task': return await handleManageTask(services, args, signal);
    }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
