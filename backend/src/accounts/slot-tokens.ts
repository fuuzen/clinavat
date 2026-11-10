import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from '../models.js';
import { readPrivateJson, writePrivateJson } from './credential-files.js';
import { accountIdentifier } from './paths.js';

export type SlotAuthMethod = 'oauth' | 'token';

interface SecretCipher { encrypt(value: string): string; decrypt(value: string): string }

const setupTokenPattern = /^sk-ant-oat[A-Za-z0-9_-]{20,500}$/;

export function parseSetupToken(value: string): string {
  const token = value.trim();
  if (!setupTokenPattern.test(token)) throw new HttpError(400, '请粘贴 claude setup-token 输出的完整令牌（以 sk-ant-oat 开头）');
  return token;
}

/**
 * Long-lived Claude tokens from `claude setup-token`. They stay encrypted in the Hub data directory, never in a
 * slot home, because slot homes are mounted into machines that agents control.
 */
export class SlotTokens {
  constructor(private dataDir: string, private cipher: SecretCipher) {}

  private file(slotId: string): string {
    return join(this.dataDir, 'accounts', 'slot-tokens', `${accountIdentifier(slotId)}.json`);
  }

  async read(slotId: string): Promise<string | undefined> {
    const content = await readPrivateJson(this.file(slotId));
    if (content === undefined) return undefined;
    try { return this.cipher.decrypt(content); }
    catch { throw new HttpError(409, '槽位长期令牌无法解密，请检查主密钥或重新设置令牌'); }
  }

  /** Stable until the token is replaced; derived from the ciphertext so identity checks never decrypt. */
  async identity(slotId: string): Promise<string | null> {
    const content = await readPrivateJson(this.file(slotId));
    return content === undefined ? null : `setup:${createHash('sha256').update(content).digest('hex').slice(0, 24)}`;
  }

  async write(slotId: string, token: string): Promise<void> {
    await writePrivateJson(this.file(slotId), this.cipher.encrypt(token));
  }

  async remove(slotId: string): Promise<void> {
    await rm(this.file(slotId), { force: true });
  }
}
