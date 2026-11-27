import { randomBytes, randomUUID } from 'node:crypto';
import { agentEnvironment, agentScope, terminateProcess } from '../environment.js';
import { readJsonLines } from '../ndjson.js';
import { answerHubMcp, hubToolNamespace, hubToolsFor } from '../orchestration-tools.js';
import type { RunServices } from '../types.js';

/**
 * Runs next to agy, in the same machine: a private Unix socket for the shim agy starts as its MCP server, carried over
 * this process's stdio to the Hub. The first stdin line is the run's token; a connection that does not present it is
 * closed. Stdout carries {ready}, {conn, line} and {conn, closed}; stdin carries {conn, line} back.
 */
const bridgeProgram = String.raw`
import hmac, json, os, socket, sys, threading
path = sys.argv[1]
token = sys.stdin.readline().strip()
os.umask(0o077)
try:
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
server.listen(8)
lock = threading.Lock()
connections = {}
def emit(value):
    with lock:
        sys.stdout.write(json.dumps(value) + '\n')
        sys.stdout.flush()
def serve(connection, number):
    reader = connection.makefile('r', encoding='utf-8', newline='\n')
    if not hmac.compare_digest(reader.readline().strip(), token):
        connection.close()
        return
    connections[number] = connection
    for line in reader:
        if line.strip():
            emit({'conn': number, 'line': line.rstrip('\n')})
    connections.pop(number, None)
    emit({'conn': number, 'closed': True})
def accept():
    number = 0
    while True:
        connection, _ = server.accept()
        number += 1
        threading.Thread(target=serve, args=(connection, number), daemon=True).start()
threading.Thread(target=accept, daemon=True).start()
emit({'ready': True})
for line in sys.stdin:
    message = json.loads(line)
    connection = connections.get(message.get('conn'))
    if connection:
        try:
            connection.sendall((message['line'] + '\n').encode())
        except OSError:
            pass
os.unlink(path)
`;

/** The MCP server agy starts: it copies stdio to the bridge's socket after presenting the token from its environment. */
export const toolShimProgram = String.raw`
import os, socket, sys, threading
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(sys.argv[1])
connection.sendall((os.environ.get('CLINAVAT_TOOLS_TOKEN', '') + '\n').encode())
def forward():
    for chunk in iter(lambda: connection.recv(65536), b''):
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    os._exit(0)
threading.Thread(target=forward, daemon=True).start()
for chunk in iter(lambda: sys.stdin.buffer.read1(65536), b''):
    connection.sendall(chunk)
connection.shutdown(socket.SHUT_WR)
`;

export interface ToolBridge {
  /** The ACP stdio MCP server entry for session/new and session/resume. */
  server: { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
  close(): void;
}

/** Starts the bridge for one run; its calls end with the run's signal. */
export async function startToolBridge(services: RunServices, shim: string, signal: AbortSignal): Promise<ToolBridge> {
  const { execution, workspaceDir } = services.config;
  const scope = agentScope(services.context, workspaceDir);
  const socket = `/tmp/clinavat-tools-${randomUUID()}.sock`;
  const token = randomBytes(24).toString('hex');
  const child = await execution.spawn('python3', ['-I', '-c', bridgeProgram, socket], {
    scope, cwd: services.context.runtime_home, env: agentEnvironment(execution, services.context, scope),
  });
  const send = (conn: number, value: unknown) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify({ conn, line: JSON.stringify(value) })}\n`);
  };
  let markReady!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; fail = reject; });
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  child.stdin.on('error', () => undefined);
  child.once('error', error => fail(error));
  child.once('close', code => fail(new Error(`编排工具通道已退出（${code}）：${diagnostics.trim()}`)));
  readJsonLines(child.stdout, (event: { ready?: boolean; conn?: number; line?: string }) => {
    if (event.ready) { markReady(); return; }
    if (typeof event.conn !== 'number' || typeof event.line !== 'string') return;
    const conn = event.conn;
    let message: { id?: unknown; method?: unknown; params?: unknown };
    try { message = JSON.parse(event.line); }
    catch { send(conn, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    void answerHubMcp(services, message, signal).then(reply => {
      if (reply && message.id !== undefined) send(conn, { jsonrpc: '2.0', id: message.id, ...reply });
    });
  }, error => fail(error));
  child.stdin.write(`${token}\n`);
  const timer = setTimeout(() => fail(new Error('编排工具通道启动超时')), 15_000);
  try { await ready; }
  catch (error) { terminateProcess(child); throw error; }
  finally { clearTimeout(timer); }
  return {
    server: { name: hubToolNamespace, command: 'python3', args: ['-I', shim, socket], env: [{ name: 'CLINAVAT_TOOLS_TOKEN', value: token }] },
    close: () => { child.stdin.end(); setTimeout(() => terminateProcess(child), 2000).unref(); },
  };
}

/** A permission request for one of the Hub's tools; the Hub approves those itself when they run. */
export function isHubToolCall(call: { name?: unknown; title?: unknown; kind?: unknown }, services: RunServices): boolean {
  const tools = hubToolsFor(services.config, services.context);
  const names = [call.name, call.title].filter((value): value is string => typeof value === 'string');
  return names.some(name => {
    const match = new RegExp(`^(?:mcp[_:./]+)?${hubToolNamespace}[_:./]+([a-z_]+)$`).exec(name.trim());
    return !!match && tools.some(tool => tool.name === match[1]);
  });
}
