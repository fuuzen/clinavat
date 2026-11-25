import { isIPv4, type Socket } from 'node:net';

export type SshRelayHop = 'target' | 'jump';

export type ParsedRelayCommand =
  | { type: 'connect'; hostId: string; hop: SshRelayHop }
  | { type: 'probe'; token: string };

const preambleMaxBytes = 256;
const preambleTimeoutMs = 5_000;
const bannerMaxLines = 16;
const bannerMaxLineBytes = 255;
const bannerTimeoutMs = 8_000;
const revokeCloseTimeoutMs = 500;
const sshBannerPattern = /^SSH-(2\.0|1\.99)-/;

export function normalizeRemoteIp(address: string | undefined): string | null {
  if (!address) return null;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIPv4(normalized) ? normalized : null;
}

export function parsePreambleCommand(line: string): ParsedRelayCommand | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'CONNECT' && parts.length === 3) {
    const [, hostId, hop] = parts;
    if (hostId && /^[a-zA-Z0-9_-]{1,80}$/.test(hostId) && (hop === 'target' || hop === 'jump')) {
      return { type: 'connect', hostId, hop };
    }
  } else if (parts[0] === 'PROBE' && parts.length === 2) {
    const [, token] = parts;
    if (token && /^[a-zA-Z0-9_-]{16,128}$/.test(token)) return { type: 'probe', token };
  }
  return null;
}

export function writeErrorAndClose(socket: Socket, message: string): void {
  const sanitized = message.replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (!socket.destroyed && socket.writable) socket.end(`ERR ${sanitized}\n`, () => { socket.destroy(); });
  else socket.destroy();
}

export function destroyAndWait(socket: Socket, timeoutMs = revokeCloseTimeoutMs): Promise<void> {
  if (socket.destroyed && socket.closed) return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    socket.once('close', finish);
    socket.destroy();
    if (socket.closed) finish();
  });
}

export function readPreamble(socket: Socket): Promise<{ line: string; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEarlyClose);
      socket.off('close', onEarlyClose);
      socket.off('error', onError);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const onEarlyClose = () => fail('connection closed before preamble');
    const onError = (error: Error) => fail(error.message);
    const onData = (chunk: Buffer) => {
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) {
        totalBytes += chunk.length;
        if (totalBytes > preambleMaxBytes) return fail('preamble too long');
        chunks.push(chunk);
        return;
      }
      if (totalBytes + nl > preambleMaxBytes) return fail('preamble too long');
      chunks.push(chunk);
      settled = true;
      cleanup();
      socket.pause();
      const combined = Buffer.concat(chunks);
      const newlineIndex = combined.indexOf(0x0a);
      resolve({
        line: combined.subarray(0, newlineIndex).toString('utf8').replace(/\r$/, ''),
        leftover: combined.subarray(newlineIndex + 1),
      });
    };
    const timer = setTimeout(() => fail('preamble timeout'), preambleTimeoutMs);
    timer.unref();
    socket.on('data', onData);
    socket.once('end', onEarlyClose);
    socket.once('close', onEarlyClose);
    socket.once('error', onError);
  });
}

/** Reads RFC 4253 identification lines from upstream before forwarding any client bytes. */
export function readSshBanner(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const currentLine: number[] = [];
    let linesRead = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEarlyClose);
      socket.off('close', onEarlyClose);
      socket.off('error', onError);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('target is not an SSH service'));
    };
    const onEarlyClose = () => fail();
    const onError = () => fail();
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (byte === 0x0a) {
          if (currentLine.length && currentLine[currentLine.length - 1] === 0x0d) currentLine.pop();
          if (currentLine.length > bannerMaxLineBytes) return fail();
          const line = Buffer.from(currentLine).toString('latin1');
          currentLine.length = 0;
          linesRead += 1;
          if (sshBannerPattern.test(line)) {
            settled = true;
            cleanup();
            socket.pause();
            resolve(Buffer.concat(chunks));
            return;
          }
          if (linesRead >= bannerMaxLines) return fail();
          continue;
        }
        if (byte === 0x00 || currentLine.length > bannerMaxLineBytes) return fail();
        currentLine.push(byte);
      }
    };
    const timer = setTimeout(fail, bannerTimeoutMs);
    timer.unref();
    socket.on('data', onData);
    socket.once('end', onEarlyClose);
    socket.once('close', onEarlyClose);
    socket.once('error', onError);
  });
}
