import type { Readable } from 'node:stream';

export function readJsonLines(stream: Readable, onValue: (value: Record<string, any>) => void, onError: (error: Error) => void) {
  const maximumLength = 8 * 1024 * 1024;
  let buffer = '';
  let closed = false;
  const fail = (error: Error) => {
    if (closed) return;
    close();
    onError(error);
  };
  const parse = (line: string) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('事件必须为JSON对象');
      onValue(value as Record<string, any>);
    } catch (error) {
      fail(new Error(`CLI 事件流无效：${error instanceof Error ? error.message : 'JSON 解析失败'}`));
    }
  };
  const onData = (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    let separator: number;
    while (!closed && (separator = buffer.indexOf('\n')) !== -1) {
      if (separator > maximumLength) { fail(new Error('CLI 单条事件超过 8 MiB，已停止会话')); return; }
      const line = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 1);
      parse(line);
    }
    if (buffer.length > maximumLength) fail(new Error('CLI 单条事件超过 8 MiB，已停止会话'));
  };
  const onEnd = () => { if (!closed) { parse(buffer); close(); } };
  const close = () => {
    if (closed) return;
    closed = true;
    buffer = '';
    stream.off('data', onData);
    stream.off('end', onEnd);
    stream.off('error', fail);
  };
  stream.setEncoding('utf8');
  stream.on('data', onData);
  stream.once('end', onEnd);
  stream.once('error', fail);
  return { close };
}
