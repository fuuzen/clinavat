import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, checkedCommand } from './process.js';
import { assertIdentifier, type RuntimeConfig } from './types.js';

export class KeyStore {
  private readonly key: Buffer;
  private readonly pending = new Map<string, Promise<{ publicKey: string; privateKeyPath: string }>>();

  constructor(private readonly config: RuntimeConfig) {
    this.key = Buffer.from(config.encryptionKey, /^[a-f\d]{64}$/i.test(config.encryptionKey) ? 'hex' : 'base64');
    if (this.key.length !== 32) throw new Error('SSH 密钥加密主密钥必须是 32 字节的 hex/base64 编码');
  }

  directory(userId: string): string {
    assertIdentifier(userId);
    return join(this.config.dataDir, 'users', userId, '.ssh');
  }

  private runtimeDirectory(userId: string): string {
    assertIdentifier(userId);
    return join(this.config.dataDir, 'run', 'keys', userId);
  }

  encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64')});
  }

  decrypt(value: string): string {
    const payload = JSON.parse(value) as {nonce: string; tag: string; data: string};
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString();
  }

  async ensureUserKey(userId: string): Promise<{publicKey: string; privateKeyPath: string}> {
    const existing = this.pending.get(userId);
    if (existing) return existing;
    const task = this.provision(userId);
    this.pending.set(userId, task);
    try { return await task; } finally { this.pending.delete(userId); }
  }

  private async provision(userId: string): Promise<{publicKey: string; privateKeyPath: string}> {
    const directory = this.directory(userId);
    const runtime = this.runtimeDirectory(userId);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await mkdir(runtime, {recursive: true, mode: 0o700});
    const privateKeyPath = join(runtime, 'id_ed25519');
    const encryptedPath = join(directory, 'id_ed25519.enc');
    let encrypted: string | undefined;
    try { encrypted = await readFile(encryptedPath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (encrypted) {
      await atomicWrite(privateKeyPath, this.decrypt(encrypted));
      await chmod(privateKeyPath, 0o600);
    } else {
      await rm(privateKeyPath, {force: true});
      await checkedCommand(this.config.sshKeygenBinary ?? 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `clinavat-${userId}`, '-f', privateKeyPath]);
      await atomicWrite(encryptedPath, this.encrypt(await readFile(privateKeyPath, 'utf8')));
    }
    const publicKey = (await checkedCommand(this.config.sshKeygenBinary ?? 'ssh-keygen', ['-y', '-P', '', '-f', privateKeyPath])).stdout.trim();
    await atomicWrite(join(directory, 'id_ed25519.pub'), `${publicKey}\n`);
    return {publicKey, privateKeyPath};
  }

  async validatePrivateKey(userId: string, privateKey: string): Promise<void> {
    if (privateKey.length > 64 * 1024) throw new Error('SSH 私钥文件过大');
    await mkdir(this.runtimeDirectory(userId), {recursive: true, mode: 0o700});
    const temporary = join(this.runtimeDirectory(userId), `validate-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(temporary, `${privateKey.trim()}\n`, {mode: 0o600});
      await checkedCommand(this.config.sshKeygenBinary ?? 'ssh-keygen', ['-y', '-P', '', '-f', temporary]);
    } finally { await rm(temporary, {force: true}); }
  }

  async importHostKey(userId: string, hostId: string, privateKey: string): Promise<void> {
    assertIdentifier(hostId);
    await this.validatePrivateKey(userId, privateKey);
    await this.ensureUserKey(userId);
    await atomicWrite(join(this.directory(userId), `${hostId}.enc`), this.encrypt(`${privateKey.trim()}\n`));
  }

  async withHostKeyRollback<T>(userId: string, hostIds: string[], operation: () => Promise<T>): Promise<T> {
    const backups = await Promise.all(hostIds.map(async hostId => {
      assertIdentifier(hostId);
      const encryptedPath = join(this.directory(userId), `${hostId}.enc`);
      const previous = await readFile(encryptedPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      return {hostId, encryptedPath, previous};
    }));
    try { return await operation(); }
    catch (error) {
      await Promise.all(backups.map(async ({hostId, encryptedPath, previous}) => {
        if (previous === undefined) await rm(encryptedPath, {force: true});
        else await atomicWrite(encryptedPath, previous);
        await rm(join(this.runtimeDirectory(userId), hostId), {force: true});
      }));
      throw error;
    }
  }

  async identityPath(userId: string, hostId: string): Promise<string> {
    assertIdentifier(hostId);
    const generated = await this.ensureUserKey(userId);
    const encryptedPath = join(this.directory(userId), `${hostId}.enc`);
    try { await access(encryptedPath); } catch { return generated.privateKeyPath; }
    const privateKeyPath = join(this.runtimeDirectory(userId), hostId);
    await atomicWrite(privateKeyPath, this.decrypt(await readFile(encryptedPath, 'utf8')));
    await chmod(privateKeyPath, 0o600);
    return privateKeyPath;
  }

  async deleteHost(userId: string, hostId: string): Promise<void> {
    assertIdentifier(hostId);
    await rm(join(this.directory(userId), `${hostId}.enc`), {force: true});
    await rm(join(this.runtimeDirectory(userId), hostId), {force: true});
  }
}
