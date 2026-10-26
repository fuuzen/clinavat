import { randomBytes } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { quoteShell, workspacePath } from './environment.js';
import type { RunServices } from './types.js';

const hookClient = String.raw`const net = require('node:net');
const [socketPath, token, timeout] = process.argv.slice(2);
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
  socket.setTimeout(Number(timeout));
  socket.on('connect', () => socket.write(JSON.stringify({token, input: payload}) + '\n'));
  socket.on('data', chunk => {
    response += chunk.toString();
    if (response.length > 2097152) return deny('工具审批响应过大');
    if (response.includes('\n')) {
      try { finish(JSON.parse(response.split('\n')[0])); } catch { deny('工具审批响应无效'); }
    }
  });
  socket.on('timeout', () => deny('工具审批超时，已拒绝'));
  socket.on('error', () => deny('工具审批服务不可用，已拒绝'));
  socket.on('end', () => { if (!finished) deny('工具审批连接已关闭'); });
});
process.stdin.on('error', () => deny('无法读取工具审批输入'));
setTimeout(() => deny('工具审批超时，已拒绝'), Number(timeout) + 1000).unref();
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

async function handleTool(services: RunServices, input: Record<string, unknown>) {
  const tool = String(input.tool_name ?? '');
  const args = input.tool_input as Record<string, unknown> | undefined;
  if (!args) return decision(false, '工具输入无效');
  const root = services.context.project.local_path;
  try {
    const cwd = await workspacePath(root, String(input.cwd ?? '.'));
    if (tool === 'Bash') {
      if (typeof args.command !== 'string' || args.run_in_background) {
        return decision(false, '仅支持同步远端命令，后台命令不受支持');
      }
      await services.verifyShell();
      const approved = await services.approve('Bash', { ...args, cwd });
      if (approved.decision !== 'allow') return decision(false, approved.reason ?? '用户拒绝执行');
      await services.verifyShell();
      const shell = path.join(root, '.bin', 'remote-shell');
      return decision(true, '用户已批准，命令在开发机执行', {
        ...args,
        run_in_background: false,
        command: `cd ${quoteShell(cwd)} && ${quoteShell(shell)} -c ${quoteShell(args.command)}`,
      });
    }
    if (['Read', 'Edit', 'Write'].includes(tool)) {
      if (typeof args.file_path !== 'string') return decision(false, '文件路径无效');
      await workspacePath(root, path.resolve(cwd, args.file_path), tool !== 'Read');
      if (tool === 'Read') return decision(true, '读取当前项目文件');
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
      return decision(true, '搜索当前项目文件');
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
  const socketPath = path.join(os.tmpdir(), `cc-pool-${randomBytes(12).toString('hex')}.sock`);
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(services.config.approvalTimeoutMs + 5000, () => socket.destroy());
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
    args: [clientPath, socketPath, token, String(services.config.approvalTimeoutMs)],
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
