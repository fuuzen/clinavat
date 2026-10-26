import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateProcess } from './environment.js';
import { readJsonLines } from './ndjson.js';

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export class RpcClient {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private lines: { close(): void };
  private closed = false;

  constructor(private child: ChildProcessWithoutNullStreams, onMessage: (message: RpcMessage) => Promise<void>, onError: (error: Error) => void) {
    const fail = (error: Error) => {
      if (this.closed) return;
      this.close(error);
      terminateProcess(child);
      onError(error);
    };
    this.lines = readJsonLines(child.stdout, (message: RpcMessage) => {
      if (typeof message.method !== 'string' && typeof message.id !== 'number' && typeof message.id !== 'string') {
        throw new Error('JSON-RPC 事件缺少有效的 method 或 id');
      }
      if (!message.method && typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? 'Codex RPC 请求失败'));
        else pending.resolve(message.result);
        return;
      }
      void onMessage(message).catch((error: unknown) => {
        if (message.id !== undefined) this.send({
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : '工具处理失败' },
        });
      });
    }, fail);
    child.stdin.on('error', fail);
    child.once('error', (error) => this.close(error));
    child.once('close', () => this.close(new Error('Codex app-server 连接已关闭')));
  }

  send(message: RpcMessage): void {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex app-server 连接已关闭'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 请求超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close(reason = new Error('Codex 连接已关闭')): void {
    this.closed = true;
    this.lines.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
  }
}
