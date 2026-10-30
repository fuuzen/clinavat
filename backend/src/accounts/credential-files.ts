import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError } from '../models.js';
import { atomicWrite } from '../runtime/process.js';
import { credentialPath, type AccountEngine } from './paths.js';

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('账号运行目录必须是实际目录');
  await chmod(directory, 0o700);
}

export async function readPrivateJson(file: string): Promise<string | undefined> {
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) {
    throw new HttpError(409, '认证或运行状态文件类型无效');
  }
  const content = await readFile(file, 'utf8');
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

const claudeAccountKeys = ['oauthAccount', 'primaryApiKey', 'customApiKeyResponses'];
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
  const content = await readPrivateJson(credentialPath(home, engine));
  const fields = accountFields(content ? JSON.parse(content) as Record<string, unknown> : {}, engine);
  if (engine === 'claude' && !fields.claudeAiOauth) {
    for (const relative of claudeConfigFiles) {
      const settings = await readPrivateJson(join(home, relative));
      if (settings && (JSON.parse(settings) as Record<string, unknown>).primaryApiKey) {
        throw new HttpError(409, '此槽位使用 Claude Console API key，当前迁移仅支持 Claude OAuth；原凭据已保留，请先完成 claude auth login');
      }
    }
  }
  return Object.keys(fields).length ? JSON.stringify(fields) : undefined;
}

export async function writeAccountCredential(home: string, engine: AccountEngine, content: string | undefined): Promise<void> {
  const file = credentialPath(home, engine);
  const existing = await readPrivateJson(file);
  if (existing === undefined && content === undefined) return;
  await privateDirectory(dirname(file));
  const document = existing ? JSON.parse(existing) as Record<string, unknown> : {};
  for (const key of engine === 'claude' ? ['claudeAiOauth'] : codexAccountKeys) delete document[key];
  if (content !== undefined) Object.assign(document, accountFields(JSON.parse(content) as Record<string, unknown>, engine));
  if (Object.keys(document).length) await writePrivateJson(file, JSON.stringify(document));
  else await rm(file, { force: true });
}

export async function clearClaudeAccount(home: string): Promise<void> {
  for (const relative of claudeConfigFiles) {
    const file = join(home, relative);
    const content = await readPrivateJson(file);
    if (content === undefined) continue;
    const settings = JSON.parse(content) as Record<string, unknown>;
    if (!claudeAccountKeys.some(key => key in settings)) continue;
    for (const key of claudeAccountKeys) delete settings[key];
    await writePrivateJson(file, JSON.stringify(settings));
  }
}

export async function copyClaudeAccount(sourceHome: string, targetHome: string): Promise<void> {
  await clearClaudeAccount(targetHome);
  for (const relative of claudeConfigFiles) {
    const source = await readPrivateJson(join(sourceHome, relative));
    if (!source) continue;
    const account = (JSON.parse(source) as Record<string, unknown>).oauthAccount;
    if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
    const file = join(targetHome, relative);
    const target = await readPrivateJson(file);
    const settings = target ? JSON.parse(target) as Record<string, unknown> : {};
    settings.oauthAccount = account;
    await writePrivateJson(file, JSON.stringify(settings));
  }
}

export async function clearRuntimeCredential(home: string, engine: AccountEngine): Promise<void> {
  await writeAccountCredential(home, engine, undefined);
  if (engine === 'claude') await clearClaudeAccount(home);
}
