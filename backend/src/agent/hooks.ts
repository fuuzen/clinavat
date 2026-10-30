import { randomBytes } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { quoteShell, workspacePath } from './environment.js';
import { getPermissionMode } from './permissions.js';
import type { RunServices } from './types.js';
import { answerClaudeQuestions } from './claude-questions.js';

const hookClient = String.raw`const net = require('node:net');
const [socketPath, token] = process.argv.slice(2);
let input = '', response = '', finished = false;
function finish(value) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
}
function deny(reason) {
  finish({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}});
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 2097152) deny('工具输入过大');
});
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { return deny('工具审批输入无效'); }
  const socket = net.connect(socketPath);
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(JSON.stringify({token, input: payload}) + '\n'));
  socket.on('data', chunk => {
    response += chunk.toString();
    if (response.length > 2097152) return deny('工具审批响应过大');
    if (response.includes('\n')) {
      try { finish(JSON.parse(response.split('\n')[0])); } catch { deny('工具审批响应无效'); }
    }
  });
  socket.on('error', () => deny('工具审批服务不可用，已拒绝'));
  socket.on('end', () => { if (!finished) deny('工具审批连接已关闭'); });
});
process.stdin.on('error', () => deny('无法读取工具审批输入'));
`;

export interface HookServer {
  command: string;
  args: string[];
  close(): Promise<void>;
}

function decision(allowed: boolean, reason: string, updatedInput?: Record<string, unknown>) {
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: allowed ? 'allow' : 'deny',
    permissionDecisionReason: reason,
    ...(updatedInput ? { updatedInput } : {}),
  } };
}

function nativeDecision(updatedInput?: Record<string, unknown>) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...(updatedInput ? { updatedInput } : {}) } };
}

async function handleTool(services: RunServices, input: Record<string, unknown>) {
  const tool = String(input.tool_name ?? '');
  const args = input.tool_input as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return decision(false, '工具输入无效');
  const root = services.context.project.local_path;
  const planning = services.context.session.agent_mode === 'plan';
  const yolo = !planning && getPermissionMode(services.context.session) === 'yolo';
  try {
    await services.control.waitUntilRunning();
    if (tool === 'AskUserQuestion') {
      // Questions must reach the user even when native tool approvals are bypassed.
      const timeout = new AbortController();
      const cancelTimeout = services.control.timer(() => timeout.abort(), services.config.approvalTimeoutMs);
      const updatedInput = await answerClaudeQuestions(services, args, timeout.signal).finally(cancelTimeout);
      return updatedInput ? decision(true, '用户已回答问题', updatedInput)
        : decision(false, '用户跳过或未回答这些问题，请依据已有信息继续，不要假定任何选项已获用户同意。');
    }
    if (tool === 'ExitPlanMode') return decision(false, '请在最终回复中展示方案并结束本轮；用户可以通过网页模式菜单切换到 Normal 后请求执行。');
    const cwd = await workspacePath(root, String(input.cwd ?? '.'));
    if (tool === 'Bash') {
      if (typeof args.command !== 'string' || args.run_in_background) {
        return decision(false, '仅支持前台命令，后台命令不受支持');
      }
      await services.verifyShell();
      if (yolo) {
        const approved = await services.approve('Bash', { ...args, cwd });
        if (approved.decision !== 'allow') return decision(false, approved.reason ?? '用户拒绝执行');
        await services.verifyShell();
      }
      if (services.context.project.execution_mode === 'local') {
        return yolo ? decision(true, 'YOLO：本系统自动批准') : nativeDecision();
      }
      const shell = path.join(root, '.bin', 'remote-shell');
      const updatedInput = {
        ...args,
        run_in_background: false,
        command: `cd ${quoteShell(cwd)} && ${quoteShell(shell)} -c ${quoteShell(args.command)}`,
      };
      return yolo ? decision(true, 'YOLO：本系统自动批准，命令在开发机执行', updatedInput) : nativeDecision(updatedInput);
    }
    if (['Read', 'Edit', 'Write'].includes(tool)) {
      if (typeof args.file_path !== 'string') return decision(false, '文件路径无效');
      const planRoot = path.join(services.context.runtime_home, '.claude', 'plans');
      const target = path.resolve(cwd, args.file_path);
      if (planning && target.startsWith(`${planRoot}${path.sep}`) && target.endsWith('.md')) {
        await workspacePath(planRoot, target, tool !== 'Read');
        return nativeDecision();
      }
      await workspacePath(root, path.resolve(cwd, args.file_path), tool !== 'Read');
      if (!yolo) return nativeDecision();
      const approved = await services.approve(tool, args);
      if (approved.decision === 'allow') await workspacePath(root, path.resolve(cwd, args.file_path), true);
      return decision(approved.decision === 'allow', approved.reason ?? '文件修改审批');
    }
    if (['Glob', 'Grep'].includes(tool)) {
      await workspacePath(root, path.resolve(cwd, String(args.path ?? '.')));
      const filePattern = String((tool === 'Glob' ? args.pattern : args.glob) ?? '');
      if (filePattern.split(/[\\/]/).some((part) => ['.bin', '.git', '.claude', '.codex'].includes(part))) {
        return decision(false, '不能搜索工作区运行配置或 Git 内部目录');
      }
      if (tool === 'Glob') {
        const pattern = String(args.pattern ?? '');
        if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
          return decision(false, 'Glob 模式必须位于当前项目目录内');
        }
      }
      if (!yolo) return nativeDecision();
      const approved = await services.approve(tool, args);
      return decision(approved.decision === 'allow', approved.reason ?? '搜索审批');
    }
    return decision(false, `当前工作台未启用工具 ${tool}`);
  } catch (error) {
    return decision(false, error instanceof Error ? error.message : '工具路径或审批校验失败');
  }
}

export async function createHookServer(services: RunServices): Promise<HookServer> {
  const runtimeDirectory = path.join(services.config.dataDir, 'agent-runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const clientPath = path.join(runtimeDirectory, 'approval-hook.cjs');
  await writeFile(clientPath, hookClient, { mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const socketPath = path.join(os.tmpdir(), `clinavat-${randomBytes(12).toString('hex')}.sock`);
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    const cancelTimeout = services.control.timer(() => socket.destroy(), services.config.approvalTimeoutMs + 5000);
    socket.once('close', cancelTimeout);
    let data = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      data += chunk.toString();
      if (data.length > 2 * 1024 * 1024) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(data.split('\n')[0]!) as { token: string; input: Record<string, unknown> };
          const result = request.token === token
            ? await handleTool(services, request.input)
            : decision(false, '审批认证无效');
          socket.end(JSON.stringify(result) + '\n');
        } catch { socket.end(JSON.stringify(decision(false, '审批请求无效')) + '\n'); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o600);
  return {
    command: process.execPath,
    args: [clientPath, socketPath, token],
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
