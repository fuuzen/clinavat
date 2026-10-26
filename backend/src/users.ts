import { randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Store } from './database.js';
import { HttpError, type User } from './models.js';
import type { SshManager } from './runtime/ssh.js';

const scrypt = promisify(deriveKey);
export const credentials = z.object({
  username: z.string().trim().min(3, '用户名至少需要 3 个字符').max(40, '用户名最多 40 个字符')
    .regex(/^[\p{L}\p{N}_.-]+$/u, '用户名只能包含字母、数字、下划线、点和连字符'),
  password: z.string().min(12, '密码至少需要 12 个字符').max(256, '密码最多 256 个字符'),
});

export async function hashPassword(password: string): Promise<string> {
  credentials.shape.password.parse(password);
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  const [salt, hash] = (passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const key = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(Buffer.from(hash, 'hex'), key) && passwordHash !== undefined;
}

export async function createUser(
  store: Store, ssh: SshManager, input: z.infer<typeof credentials>,
  role: User['role'] = 'user', requireEmpty = false,
) {
  if (requireEmpty && store.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, '平台已初始化');
  if (store.get('SELECT id FROM users WHERE username=?', input.username)) throw new HttpError(409, '用户名已存在');
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  try {
    const sshKey = await ssh.ensureUserKey(id);
    const result = store.createUser({ id, username: input.username, password_hash: passwordHash, role }, requireEmpty);
    return { ...result, publicKey: sshKey.publicKey };
  } catch (error) {
    await Promise.allSettled([
      rm(join(ssh.config.dataDir, 'users', id), { recursive: true, force: true }),
      rm(join(ssh.config.dataDir, 'run', 'keys', id), { recursive: true, force: true }),
    ]);
    throw error;
  }
}
