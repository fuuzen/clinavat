import { chmod, readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { atomicWrite } from './process.js';
import type { SshRelayHop } from './ssh-relay-protocol.js';
import { assertIdentifier, shellQuote } from './types.js';

export const sshRelayClientFilename = 'ssh-relay-client.py';

export function sshRelayClientPath(sshDirectory: string): string {
  return join(sshDirectory, sshRelayClientFilename);
}

export function renderSshRelayClient(relayHost: string, relayPort: number): string {
  if (!isIPv4(relayHost)) throw new Error(`无效的 SSH 中继监听地址：${relayHost}`);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`无效的 SSH 中继端口：${relayPort}`);
  }
  return `#!/usr/bin/env python3
import os
import selectors
import signal
import socket
import stat
import sys

DEFAULT_HOST = ${JSON.stringify(relayHost)}
DEFAULT_PORT = ${relayPort}
CHUNK_SIZE = 65536
HIGH_WATER = 262144
HANDSHAKE_TIMEOUT = 15.0
MAX_RESPONSE_BYTES = 1024


def fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"ssh-relay-client: {message}\\n")
    sys.stderr.flush()
    sys.exit(code)


def parse_args(argv: list[str]) -> tuple[str, int, str]:
    host = DEFAULT_HOST
    port = DEFAULT_PORT
    args = list(argv)
    while len(args) >= 2 and args[0] in ("--host", "--port"):
        flag = args.pop(0)
        value = args.pop(0)
        if flag == "--host":
            host = value
        else:
            try:
                port = int(value)
            except ValueError:
                fail(f"invalid relay port: {value}", 2)
    if len(args) == 3 and args[0] == "connect" and args[2] in ("target", "jump"):
        return host, port, f"CONNECT {args[1]} {args[2]}\\n"
    if len(args) == 2 and args[0] == "probe":
        return host, port, f"PROBE {args[1]}\\n"
    fail("usage: ssh-relay-client.py [--host IP --port PORT] (connect <hostId> <target|jump> | probe <token>)", 2)
    raise AssertionError("unreachable")


def handshake(sock: socket.socket, preamble: str) -> bytes:
    sock.settimeout(HANDSHAKE_TIMEOUT)
    sock.sendall(preamble.encode("utf-8"))
    buf = bytearray()
    while True:
        nl = buf.find(b"\\n")
        if nl != -1:
            break
        if len(buf) > MAX_RESPONSE_BYTES:
            fail("relay response exceeded maximum length")
        chunk = sock.recv(4096)
        if not chunk:
            fail("relay closed connection before response")
        buf.extend(chunk)
    line = bytes(buf[:nl]).rstrip(b"\\r").decode("utf-8", "replace")
    leftover = bytes(buf[nl + 1:])
    if line != "OK":
        if line.startswith("ERR "):
            fail(line[4:])
        fail(f"unexpected relay response: {line or 'empty'}")
    return leftover


def update_selector(sel: selectors.BaseSelector, key_obj, events: int) -> None:
    try:
        current = sel.get_key(key_obj)
    except KeyError:
        current = None
    if events == 0:
        if current is not None:
            sel.unregister(key_obj)
    elif current is None:
        sel.register(key_obj, events)
    elif current.events != events:
        sel.modify(key_obj, events)


def relay_stdio(sock: socket.socket, leftover: bytes) -> None:
    sock.setblocking(False)
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    os.set_blocking(stdin_fd, False)
    os.set_blocking(stdout_fd, False)

    to_sock = bytearray()
    to_stdout = bytearray(leftover)
    stdin_eof = False
    sock_eof = False
    sock_write_closed = False
    stdout_closed = False

    def close_stdout() -> None:
        nonlocal stdout_closed
        if stdout_closed:
            return
        stdout_closed = True
        try:
            if stat.S_ISSOCK(os.fstat(stdout_fd).st_mode):
                dup = socket.socket(fileno=os.dup(stdout_fd))
                try:
                    dup.shutdown(socket.SHUT_WR)
                finally:
                    dup.close()
            else:
                os.close(stdout_fd)
        except OSError:
            pass

    def shutdown_sock_write() -> None:
        nonlocal sock_write_closed
        if sock_write_closed:
            return
        sock_write_closed = True
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    sel = selectors.DefaultSelector()
    same_stdio = stdin_fd == stdout_fd
    try:
        while True:
            if stdin_eof and not to_sock and not sock_write_closed:
                shutdown_sock_write()
            if sock_eof and not to_stdout and not stdout_closed:
                close_stdout()
            if sock_write_closed and stdout_closed:
                break

            stdin_ev = selectors.EVENT_READ if (not stdin_eof and not sock_write_closed and len(to_sock) < HIGH_WATER) else 0
            stdout_ev = selectors.EVENT_WRITE if (not stdout_closed and len(to_stdout) > 0) else 0
            sock_ev = (
                (selectors.EVENT_READ if (not sock_eof and not stdout_closed and len(to_stdout) < HIGH_WATER) else 0)
                | (selectors.EVENT_WRITE if (not sock_write_closed and len(to_sock) > 0) else 0)
            )
            if (stdin_ev | stdout_ev | sock_ev) == 0:
                break

            if same_stdio:
                update_selector(sel, stdin_fd, stdin_ev | stdout_ev)
            else:
                update_selector(sel, stdin_fd, stdin_ev)
                update_selector(sel, stdout_fd, stdout_ev)
            update_selector(sel, sock, sock_ev)

            for key, mask in sel.select():
                obj = key.fileobj
                if obj == stdin_fd and (mask & selectors.EVENT_READ):
                    try:
                        data = os.read(stdin_fd, CHUNK_SIZE)
                    except BlockingIOError:
                        pass
                    except OSError:
                        stdin_eof = True
                    else:
                        if not data:
                            stdin_eof = True
                        else:
                            to_sock.extend(data)
                if obj == stdout_fd and (mask & selectors.EVENT_WRITE):
                    try:
                        written = os.write(stdout_fd, memoryview(to_stdout)[:CHUNK_SIZE])
                    except BlockingIOError:
                        pass
                    except OSError:
                        to_stdout.clear()
                        stdout_closed = True
                    else:
                        if written > 0:
                            del to_stdout[:written]
                if obj is sock:
                    if mask & selectors.EVENT_READ:
                        try:
                            data = sock.recv(CHUNK_SIZE)
                        except BlockingIOError:
                            pass
                        except OSError:
                            sock_eof = True
                        else:
                            if not data:
                                sock_eof = True
                            else:
                                to_stdout.extend(data)
                    if mask & selectors.EVENT_WRITE:
                        try:
                            sent = sock.send(memoryview(to_sock)[:CHUNK_SIZE])
                        except BlockingIOError:
                            pass
                        except OSError:
                            to_sock.clear()
                            sock_write_closed = True
                        else:
                            if sent > 0:
                                del to_sock[:sent]
    finally:
        sel.close()


def main() -> None:
    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    host, port, preamble = parse_args(sys.argv[1:])
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(HANDSHAKE_TIMEOUT)
        sock.connect((host, port))
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        leftover = handshake(sock, preamble)
        relay_stdio(sock, leftover)
    except OSError as exc:
        fail(f"failed to connect to relay {host}:{port}: {exc}")
    finally:
        try:
            sock.close()
        except OSError:
            pass


if __name__ == "__main__":
    main()
`;
}

export async function ensureSshRelayClient(sshDirectory: string, relayHost: string, relayPort: number): Promise<string> {
  const path = sshRelayClientPath(sshDirectory);
  const content = renderSshRelayClient(relayHost, relayPort);
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (existing !== content) {
    await atomicWrite(path, content, 0o755);
  }
  await chmod(path, 0o755);
  return path;
}

export function buildConnectProxyCommand(scriptPath: string, hostId: string, hop: SshRelayHop): string {
  assertIdentifier(hostId);
  return `python3 -I ${shellQuote(scriptPath)} connect ${shellQuote(hostId)} ${hop}`;
}

export function buildProbeProxyCommand(scriptPath: string, token: string): string {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(token)) throw new Error('无效的探测令牌格式');
  return `python3 -I ${shellQuote(scriptPath)} probe ${shellQuote(token)}`;
}
