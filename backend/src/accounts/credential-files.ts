import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError } from '../models.js';
import { openContained } from '../runtime/contained-files.js';
import { atomicWrite } from '../runtime/process.js';
import { credentialPath, type AccountEngine } from './paths.js';

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('账号运行目录必须是实际目录');
  await chmod(directory, 0o700);
}

/** Reads a JSON document that may live in a tree writable by an execution environment; `root` is the trusted boundary. */
export async function readPrivateJson(file: string, root = dirname(file)): Promise<string | undefined> {
  const opened = await openContained(root, file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new HttpError(409, '认证或运行状态文件类型无效');
  });
  if (!opened) return undefined;
  let content: string;
  try {
    if (opened.size > 4 * 1024 * 1024) throw new HttpError(409, '认证或运行状态文件类型无效');
    content = await opened.handle.readFile('utf8');
  } finally { await opened.handle.close(); }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
  } catch { throw new HttpError(409, '认证或运行状态文件不是有效的 JSON 对象'); }
  return content;
}

export function credentialHash(content: string | undefined): string | null {
  return content === undefined ? null : createHash('sha256').update(content).digest('hex');
}

export async function writePrivateJson(file: string, content: string): Promise<void> {
  await privateDirectory(dirname(file));
  await atomicWrite(file, content);
}

const claudeConfigFiles = ['.claude.json', join('.claude', '.claude.json')];
const codexAccountKeys = ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'];

function accountFields(document: Record<string, unknown>, engine: AccountEngine): Record<string, unknown> {
  if (engine === 'claude') {
    if (document.claudeAiOauth === undefined) return {};
    const oauth = document.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)
      || typeof (oauth as Record<string, unknown>).accessToken !== 'string') {
      throw new HttpError(409, 'Claude OAuth 凭据格式无效，请重新登录');
    }
    return { claudeAiOauth: oauth };
  }
  if (document.auth_mode !== undefined && !['apikey', 'chatgpt'].includes(String(document.auth_mode))) {
    throw new HttpError(409, '当前槽位仅支持 Codex 文件登录凭据，请使用 codex login 登录');
  }
  const fields = Object.fromEntries(codexAccountKeys.filter(key => key in document).map(key => [key, document[key]]));
  const tokens = fields.tokens;
  const hasToken = tokens && typeof tokens === 'object' && !Array.isArray(tokens)
    && typeof (tokens as Record<string, unknown>).access_token === 'string';
  if (!hasToken && !(typeof fields.OPENAI_API_KEY === 'string' && fields.OPENAI_API_KEY)) return {};
  return fields;
}

export async function readAccountCredential(home: string, engine: AccountEngine): Promise<string | undefined> {
  const content = await readPrivateJson(credentialPath(home, engine), home);
  const fields = accountFields(content ? JSON.parse(content) as Record<string, unknown> : {}, engine);
  if (engine === 'claude' && !fields.claudeAiOauth) {
    for (const relative of claudeConfigFiles) {
      const settings = await readPrivateJson(join(home, relative), home);
      if (settings && (JSON.parse(settings) as Record<string, unknown>).primaryApiKey) {
        throw new HttpError(409, '此槽位使用 Claude Console API key，当前仅支持 Claude OAuth；原凭据已保留，请先完成 claude auth login');
      }
    }
  }
  return Object.keys(fields).length ? JSON.stringify(fields) : undefined;
}
