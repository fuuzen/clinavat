import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import type { WebSocket } from 'ws';
import { childEnvironment } from './process.js';
import type { WorkspaceProject } from './types.js';
import type { WorkspaceManager } from './workspace.js';

// Python's standard library provides a controlling PTY without a Node native addon.
const terminalBridge = String.raw`
import base64, errno, fcntl, json, os, select, signal, struct, sys, termios, time

def emit(message):
    print(json.dumps(message), flush=True)

pid, master = os.forkpty()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['PWD'] = os.getcwd()
    os.execv('/bin/bash', ['bash', '-l', '-i'])

stopping = False
reaped = False
def stop(*args):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
os.set_blocking(master, False)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
buffer = b''
pending = b''
pty_open = True
emit({'type': 'ready'})
try:
    while not stopping:
        readers, writers, _ = select.select([sys.stdin.fileno()] + ([master] if pty_open else []), [master] if pty_open and pending else [], [], 0.2)
        if master in readers:
            try:
                output = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                output = b''
            if output:
                emit({'type': 'output', 'data': base64.b64encode(output).decode('ascii')})
            else:
                pty_open = False
        if master in writers:
            try:
                written = os.write(master, pending)
                pending = pending[written:]
            except OSError as error:
                if error.errno not in (errno.EIO, errno.EAGAIN):
                    raise
        if sys.stdin.fileno() in readers:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                stopping = True
                break
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                message = json.loads(line)
                if message['type'] == 'input':
                    pending += base64.b64decode(message['data'])
                    if len(pending) > 1024 * 1024:
                        raise RuntimeError('terminal input buffer exceeded')
                elif message['type'] == 'resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', message['rows'], message['cols'], 0, 0))
        child, status = os.waitpid(pid, os.WNOHANG)
        if child:
            reaped = True
            # Drain output already queued by the child before reporting its exit.
            while True:
                try:
                    output = os.read(master, 65536)
                    if not output:
                        break
                    emit({'type': 'output', 'data': base64.b64encode(output).decode('ascii')})
                except OSError as error:
                    if error.errno not in (errno.EIO, errno.EAGAIN):
                        raise
                    break
            emit({'type': 'exit', 'code': os.waitstatus_to_exitcode(status)})
            break
finally:
    groups = {pid}
    try:
        foreground = os.tcgetpgrp(master)
        if foreground > 0:
            groups.add(foreground)
    except OSError:
        pass
    os.close(master)
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        for group in groups:
            try:
                os.killpg(group, sig)
            except ProcessLookupError:
                pass
        if not reaped:
            for _ in range(5):
                child, _ = os.waitpid(pid, os.WNOHANG)
                if child:
                    reaped = True
                    break
                time.sleep(0.02)
        remaining = set()
        for group in groups:
            try:
                os.killpg(group, 0)
                remaining.add(group)
            except ProcessLookupError:
                pass
        groups = remaining
        if reaped and not groups:
            break
    if not reaped:
        os.waitpid(pid, 0)
`;

export async function attachLocalTerminal(socket: WebSocket, project: WorkspaceProject, workspaces: WorkspaceManager): Promise<void> {
  await workspaces.flush(project);
  if (socket.readyState !== 1) return;
  // The administrator's local-host terminal is a host shell by design, even when agents run in VMs.
  const child = spawn('python3', ['-u', '-c', terminalBridge], {
    cwd: project.local_path,
    env: childEnvironment({PWD: project.local_path, TERM: 'xterm-256color'}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  const lines = createInterface({input: child.stdout});
  let closed = false;
  let exited = false;
  let bytes = 0;
  let intervalStarted = Date.now();
  let errorOutput = '';
  const send = (message: unknown) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, '终端输出过快，请重新连接'); return; }
    socket.send(JSON.stringify(message));
  };
  const shutdown = () => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    child.kill('SIGTERM');
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    force.unref();
    child.once('close', () => clearTimeout(force));
  };
  socket.once('close', shutdown);
  socket.once('error', shutdown);
  socket.on('message', raw => {
    if (closed || exited) return;
    const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    if (Date.now() - intervalStarted > 1000) { bytes = 0; intervalStarted = Date.now(); }
    bytes += data.length;
    if (bytes > 256 * 1024) { socket.close(1009, '终端输入过大'); return; }
    try {
      const message = JSON.parse(data.toString()) as {type?: string; data?: string; rows?: number; cols?: number};
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 64 * 1024) {
        child.stdin.write(JSON.stringify({type: 'input', data: Buffer.from(message.data).toString('base64')}) + '\n');
      } else if (message.type === 'resize' && Number.isInteger(message.rows) && Number.isInteger(message.cols)) {
        child.stdin.write(JSON.stringify({type: 'resize', rows: Math.max(1, Math.min(message.rows!, 500)), cols: Math.max(1, Math.min(message.cols!, 500))}) + '\n');
      }
    } catch { send({type: 'error', message: '终端消息格式无效'}); }
  });
  child.stdin.on('error', () => shutdown());
  child.stderr.on('data', (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(-4000); });
  lines.on('line', line => {
    if (closed) return;
    try {
      const message = JSON.parse(line) as {type: string; data?: string; code?: number};
      if (message.type === 'output' && typeof message.data === 'string') {
        const data = decoder.write(Buffer.from(message.data, 'base64'));
        if (data) send({type: 'output', data});
      } else if (message.type === 'exit') {
        exited = true;
        const tail = decoder.end();
        if (tail) send({type: 'output', data: tail});
        send({type: 'exit', code: message.code ?? 0});
        socket.close(1000, '终端已结束');
      } else if (message.type === 'ready') send({type: 'ready'});
    } catch {
      send({type: 'error', message: '本机终端响应格式无效'});
      socket.close(1011, '终端通道错误');
      shutdown();
    }
  });
  child.once('error', error => {
    send({type: 'error', message: `无法启动本机终端：${error.message}；请确认服务环境已安装 Python 3`});
    socket.close(1011, '无法启动本机终端');
    shutdown();
  });
  child.once('close', () => {
    lines.close();
    if (!closed && !exited) {
      send({type: 'error', message: errorOutput.trim() || '本机终端异常结束'});
      socket.close(1011, '本机终端已断开');
    }
    shutdown();
  });
}
