import { resolve } from 'node:path';
import { z } from 'zod';

const environment = z.object({
  CC_POOL_DATA_DIR: z.string().default('../data'),
  CC_POOL_MASTER_KEY: z.string().regex(/^[a-f\d]{64}$/i, 'CC_POOL_MASTER_KEY 必须是 32 字节十六进制密钥'),
  CC_POOL_HOST: z.string().default('127.0.0.1'),
  CC_POOL_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CC_POOL_ORIGIN: z.url().optional(),
  CC_POOL_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  CC_POOL_REGISTRATION: z.enum(['true', 'false']).default('false'),
  CC_POOL_CLAUDE_BIN: z.string().default('claude'),
  CC_POOL_CODEX_BIN: z.string().default('codex'),
  CC_POOL_MUTAGEN_BIN: z.string().default('mutagen'),
  CC_POOL_SSH_BIN: z.string().default('ssh'),
  CC_POOL_SSH_KEYGEN_BIN: z.string().default('ssh-keygen'),
  CC_POOL_APPROVAL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300000),
}).parse(process.env);

export const config = {
  dataDir: resolve(environment.CC_POOL_DATA_DIR),
  encryptionKey: environment.CC_POOL_MASTER_KEY,
  host: environment.CC_POOL_HOST,
  port: environment.CC_POOL_PORT,
  origin: environment.CC_POOL_ORIGIN,
  secureCookie: environment.CC_POOL_COOKIE_SECURE === 'true',
  registrationEnabled: environment.CC_POOL_REGISTRATION === 'true',
  claudeBinary: environment.CC_POOL_CLAUDE_BIN,
  codexBinary: environment.CC_POOL_CODEX_BIN,
  mutagenBinary: environment.CC_POOL_MUTAGEN_BIN,
  sshBinary: environment.CC_POOL_SSH_BIN,
  sshKeygenBinary: environment.CC_POOL_SSH_KEYGEN_BIN,
  approvalTimeoutMs: environment.CC_POOL_APPROVAL_TIMEOUT_MS,
};

export type Config = typeof config;
