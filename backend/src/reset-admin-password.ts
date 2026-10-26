import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { credentials, hashPassword } from './users.js';

interface Administrator { id: string; username: string }
const usage = `用法：
  admin:reset-password -- --username <管理员用户名> [--data-dir <数据目录>]
  admin:reset-password -- --list [--data-dir <数据目录>]

新密码在终端内隐藏输入并确认，长度为 12–256 个字符。
数据目录默认读取 CC_POOL_DATA_DIR，否则使用后端目录下的 ../data。
`;

function hiddenInput(prompt: string): Promise<string> {
  return new Promise((resolveInput, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const terminal = createInterface({ input, output: mutedOutput, terminal: true, historySize: 0 });
    let finished = false;
    const finish = (error?: Error, value?: string) => {
      if (finished) return;
      finished = true;
      process.off('SIGTERM', cancel);
      terminal.close();
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      mutedOutput.end();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolveInput(value ?? '');
    };
    const cancel = () => finish(new Error('已取消，密码未修改'));
    terminal.once('SIGINT', cancel);
    terminal.once('close', () => finish(new Error('输入已结束，密码未修改')));
    terminal.once('error', error => finish(error));
    process.once('SIGTERM', cancel);
    process.stdout.write(prompt);
    terminal.question('', value => finish(undefined, value));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      'data-dir': { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true, allowPositionals: false,
  });
  if (values.help) { process.stdout.write(usage); return; }
  if (values.list && values.username) throw new Error('--list 和 --username 不能同时使用');
  if (!values.list && !values.username) throw new Error('请通过 --username 指定管理员；忘记用户名时可用 --list 列出');
  const dataDir = resolve(values['data-dir'] ?? process.env.CC_POOL_DATA_DIR ?? '../data');
  const databasePath = join(dataDir, 'cc-pool.sqlite');
  const metadata = await stat(databasePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`数据库不存在：${databasePath}，请确认 --data-dir`);
    throw error;
  });
  if (!metadata.isFile()) throw new Error('数据库路径必须是现有的普通文件');
  const lookup = new DatabaseSync(databasePath, { readOnly: true });
  let administrators: Administrator[];
  try {
    administrators = lookup.prepare("SELECT id,username FROM users WHERE role='admin' ORDER BY username").all() as unknown as Administrator[];
    lookup.prepare('SELECT token_hash FROM auth_sessions LIMIT 0').all();
  } finally { lookup.close(); }
  if (!administrators.length) throw new Error('此数据库中没有管理员，请确认数据目录');
  if (values.list) {
    process.stdout.write(`管理员账号（${databasePath}）：\n${administrators.map(user => `  ${user.username}`).join('\n')}\n`);
    return;
  }
  const username = credentials.shape.username.parse(values.username);
  const administrator = administrators.find(user => user.username === username);
  if (!administrator) throw new Error('未找到该管理员账号；可用 --list 列出管理员');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('重置密码需要交互式终端；容器内请使用 compose exec 或 exec -it');
  await access(databasePath, constants.R_OK | constants.W_OK);
  process.stdout.write(`数据文件：${databasePath}\n重置管理员：${administrator.username}\n`);
  const password = await hiddenInput('新密码：');
  credentials.shape.password.parse(password);
  const confirmation = await hiddenInput('再次输入新密码：');
  if (password !== confirmation) throw new Error('两次密码输入不一致，密码未修改');
  const passwordHash = await hashPassword(password);
  const database = new DatabaseSync(databasePath);
  let revoked = 0;
  try {
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const updated = database.prepare("UPDATE users SET password_hash=? WHERE id=? AND username=? AND role='admin'")
        .run(passwordHash, administrator.id, username);
      if (updated.changes !== 1) throw new Error('管理员账号已变更，密码未修改');
      revoked = Number(database.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(administrator.id).changes);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } finally { database.close(); }
  process.stdout.write(`已重置管理员「${username}」密码，并撤销 ${revoked} 个登录会话。\n`);
  process.stdout.write('请使用新密码登录。旧终端和事件连接将在最多 15 秒内关闭。\n');
}

try { await main(); }
catch (error) {
  const message = error instanceof ZodError
    ? error.issues.map(issue => issue.message).join('；')
    : error instanceof Error ? error.message : '密码重置失败';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
