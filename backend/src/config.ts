import { resolve } from 'node:path';
import { z } from 'zod';
import { brandedEnvironment, defaultWorkspaceDirectory } from './storage-paths.js';

const environment = z.object({
  CLINAVAT_DATA_DIR: z.string().default('../data'),
  CLINAVAT_WORKSPACE_DIR: z.string().default(defaultWorkspaceDirectory()),
  CLINAVAT_MASTER_KEY: z.string().regex(/^[a-f\d]{64}$/i, 'CLINAVAT_MASTER_KEY 必须是 32 字节十六进制密钥'),
  CLINAVAT_HOST: z.string().default('127.0.0.1'),
  CLINAVAT_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CLINAVAT_WEB_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  VITE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  CLINAVAT_ORIGIN: z.string().optional(),
  CLINAVAT_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  CLINAVAT_REGISTRATION: z.enum(['true', 'false']).default('false'),
  CLINAVAT_CLAUDE_BIN: z.string().default('claude'),
  CLINAVAT_CODEX_BIN: z.string().default('codex'),
  CLINAVAT_MUTAGEN_BIN: z.string().default('mutagen'),
  CLINAVAT_SSH_BIN: z.string().default('ssh'),
  CLINAVAT_SSH_KEYGEN_BIN: z.string().default('ssh-keygen'),
  CLINAVAT_APPROVAL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300000),
  CLINAVAT_GATEWAY_HOST: z.string().trim().regex(/^[A-Za-z0-9.:-]*$/, 'CLINAVAT_GATEWAY_HOST 必须是主机名或 IP').default(''),
  CLINAVAT_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(22),
  CLINAVAT_GATEWAY_USER: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('root'),
}).parse(brandedEnvironment());
// The parsed config is the only holder of the master key; a later {...process.env} cannot hand it to a child.
for (const name of ['CLINAVAT_MASTER_KEY', 'CC_POOL_MASTER_KEY']) delete process.env[name];

export const config = {
  dataDir: resolve(environment.CLINAVAT_DATA_DIR),
  workspaceDir: resolve(environment.CLINAVAT_WORKSPACE_DIR),
  encryptionKey: environment.CLINAVAT_MASTER_KEY,
  host: environment.CLINAVAT_HOST,
  port: environment.CLINAVAT_PORT,
  webPort: environment.CLINAVAT_WEB_PORT,
  vitePort: process.env.NODE_ENV === 'production' ? undefined : environment.VITE_PORT ?? 5173,
  initialPublicOrigins: environment.CLINAVAT_ORIGIN,
  secureCookie: environment.CLINAVAT_COOKIE_SECURE === 'true',
  registrationEnabled: environment.CLINAVAT_REGISTRATION === 'true',
  claudeBinary: environment.CLINAVAT_CLAUDE_BIN,
  codexBinary: environment.CLINAVAT_CODEX_BIN,
  mutagenBinary: environment.CLINAVAT_MUTAGEN_BIN,
  sshBinary: environment.CLINAVAT_SSH_BIN,
  sshKeygenBinary: environment.CLINAVAT_SSH_KEYGEN_BIN,
  approvalTimeoutMs: environment.CLINAVAT_APPROVAL_TIMEOUT_MS,
  gateway: environment.CLINAVAT_GATEWAY_HOST ? {
    host: environment.CLINAVAT_GATEWAY_HOST, port: environment.CLINAVAT_GATEWAY_PORT, username: environment.CLINAVAT_GATEWAY_USER,
  } : undefined,
};

export type Config = typeof config;
