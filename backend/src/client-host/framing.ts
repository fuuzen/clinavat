export const FRAME_HEADER_SIZE = 9;
export const MAX_FRAME_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_STREAM_PENDING_BYTES = 4 * 1024 * 1024;

export const FrameType = {
  RPC_REQUEST: 0x01,
  RPC_RESPONSE: 0x02,
  STREAM_DATA: 0x03,
  STREAM_EOF: 0x04,
  STREAM_CANCEL: 0x05,
} as const;

export type FrameTypeCode = (typeof FrameType)[keyof typeof FrameType];

export interface DecodedFrame {
  frameType: FrameTypeCode;
  streamId: number;
  payload: Buffer;
}

export interface RpcErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RpcRequestContext {
  id: number;
  streamId: number;
  signal: AbortSignal;
}

export type RpcRequestHandler = (params: unknown, context: RpcRequestContext) => unknown | Promise<unknown>;

export interface MuxStream {
  readonly streamId: number;
  readonly closed: boolean;
  readonly initialResult?: unknown;
  sendData(buf: Buffer | Uint8Array): Promise<void>;
  sendEof(meta?: unknown): Promise<void>;
  cancel(reason?: string): Promise<void>;
  onData(listener: (chunk: Buffer) => void): () => void;
  onEof(listener: (meta?: unknown) => void): () => void;
  onCancel(listener: (error: Error) => void): () => void;
}

export interface FrameWriter {
  writeFrame(frameType: FrameTypeCode, streamId: number, payload?: Buffer): Promise<void>;
}

export class MuxStreamImpl implements MuxStream {
  initialResult?: unknown;
  private localEnded = false;
  private remoteEnded = false;
  private cancelled = false;
  private cancelError?: Error;
  private eofReceived = false;
  private eofMeta?: unknown;
  private readonly pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly eofListeners = new Set<(meta?: unknown) => void>();
  private readonly cancelListeners = new Set<(error: Error) => void>();
  private detachAbort?: () => void;

  constructor(
    public readonly streamId: number,
    private readonly writer: FrameWriter,
    private readonly onRemove: () => void,
    private readonly maxPendingBytes = MAX_STREAM_PENDING_BYTES,
  ) {}

  get closed(): boolean { return this.cancelled || (this.localEnded && this.remoteEnded); }

  bindAbortSignal(signal?: AbortSignal): void {
    if (!signal) return;
    if (signal.aborted) { void this.cancel(createAbortError(signal.reason).message); return; }
    const onAbort = () => { void this.cancel(createAbortError(signal.reason).message); };
    signal.addEventListener('abort', onAbort, { once: true });
    this.detachAbort = () => { signal.removeEventListener('abort', onAbort); this.detachAbort = undefined; };
  }

  async sendData(buf: Buffer | Uint8Array): Promise<void> {
    if (this.cancelled) throw this.cancelError ?? new Error('流已取消');
    if (this.localEnded) throw new Error('流写入端已关闭');
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    await this.writer.writeFrame(FrameType.STREAM_DATA, this.streamId, data);
  }

  async sendEof(meta?: unknown): Promise<void> {
    if (this.cancelled || this.localEnded) return;
    this.localEnded = true;
    const payload = meta === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(meta), 'utf8');
    await this.writer.writeFrame(FrameType.STREAM_EOF, this.streamId, payload);
    this.checkFinished();
  }

  async cancel(reason?: string): Promise<void> {
    if (this.cancelled) return;
    this.terminate(new Error(reason || '流已取消'));
    const payload = reason ? Buffer.from(JSON.stringify({ reason }), 'utf8') : Buffer.alloc(0);
    await this.writer.writeFrame(FrameType.STREAM_CANCEL, this.streamId, payload).catch(() => undefined);
  }

  onData(listener: (chunk: Buffer) => void): () => void {
    this.dataListeners.add(listener);
    if (this.pendingChunks.length > 0) {
      this.pendingBytes = 0;
      for (const chunk of this.pendingChunks.splice(0)) listener(chunk);
    }
    return () => { this.dataListeners.delete(listener); };
  }

  onEof(listener: (meta?: unknown) => void): () => void {
    this.eofListeners.add(listener);
    if (this.eofReceived) listener(this.eofMeta);
    return () => { this.eofListeners.delete(listener); };
  }

  onCancel(listener: (error: Error) => void): () => void {
    this.cancelListeners.add(listener);
    if (this.cancelled) listener(this.cancelError ?? new Error('流已取消'));
    return () => { this.cancelListeners.delete(listener); };
  }

  handleData(chunk: Buffer): void {
    if (this.cancelled || this.remoteEnded) return;
    if (this.dataListeners.size === 0) {
      if (this.pendingBytes + chunk.length > this.maxPendingBytes) {
        this.pendingChunks.length = 0;
        this.pendingBytes = 0;
        void this.cancel(`流未消费缓冲超过上限 (${this.maxPendingBytes} 字节)`);
        return;
      }
      this.pendingChunks.push(chunk);
      this.pendingBytes += chunk.length;
      return;
    }
    for (const listener of this.dataListeners) listener(chunk);
  }

  handleEof(meta?: unknown): void {
    if (this.cancelled || this.remoteEnded) return;
    this.remoteEnded = true;
    this.eofReceived = true;
    this.eofMeta = meta;
    for (const listener of this.eofListeners) listener(meta);
    this.checkFinished();
  }

  terminate(error: Error): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelError = error;
    this.pendingChunks.length = 0;
    this.pendingBytes = 0;
    this.detachAbort?.();
    this.onRemove();
    for (const listener of this.cancelListeners) listener(error);
  }

  private checkFinished(): void {
    if (this.localEnded && this.remoteEnded) {
      this.detachAbort?.();
      this.onRemove();
    }
  }
}

export class ClientDisconnectedError extends Error {
  readonly code = 'CLIENT_DISCONNECTED';
  readonly statusCode = 503;
  constructor(message = '客户端连接已断开') {
    super(message);
    this.name = 'ClientDisconnectedError';
  }
}

export class ProtocolError extends Error {
  readonly code = 'PROTOCOL_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class RpcError extends Error {
  constructor(public readonly code: string, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : '操作已取消');
  error.name = 'AbortError';
  return error;
}

export function encodeFrame(frameType: FrameTypeCode, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.writeUInt8(frameType, 4);
  frame.writeUInt32BE(streamId >>> 0, 5);
  if (payload.length > 0) payload.copy(frame, FRAME_HEADER_SIZE);
  return frame;
}

/** Incremental decoder for `[u32BE payloadLen][u8 frameType][u32BE streamId][payload]` frames. */
export class FrameDecoder {
  private readonly chunks: Buffer[] = [];
  private offset = 0;
  private totalBytes = 0;

  constructor(private readonly maxPayloadBytes = MAX_FRAME_PAYLOAD_BYTES) {}

  push(chunk: Buffer): DecodedFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.totalBytes += chunk.length;
    }
    const frames: DecodedFrame[] = [];
    while (this.totalBytes >= FRAME_HEADER_SIZE) {
      const header = this.peek(FRAME_HEADER_SIZE);
      const payloadLen = header.readUInt32BE(0);
      const frameType = header.readUInt8(4);
      const streamId = header.readUInt32BE(5);
      if (payloadLen > this.maxPayloadBytes) {
        throw new ProtocolError(`帧载荷超出上限 (${payloadLen} > ${this.maxPayloadBytes})`);
      }
      if (frameType < FrameType.RPC_REQUEST || frameType > FrameType.STREAM_CANCEL) {
        throw new ProtocolError(`未知帧类型：0x${frameType.toString(16)}`);
      }
      if (this.totalBytes < FRAME_HEADER_SIZE + payloadLen) break;
      this.consume(FRAME_HEADER_SIZE);
      const payload = payloadLen > 0 ? this.consume(payloadLen) : Buffer.alloc(0);
      frames.push({ frameType: frameType as FrameTypeCode, streamId, payload });
    }
    return frames;
  }

  private peek(length: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length - this.offset >= length) {
      return first.subarray(this.offset, this.offset + length);
    }
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    let chunkIndex = 0;
    let chunkOffset = this.offset;
    while (copied < length) {
      const current = this.chunks[chunkIndex++]!;
      const take = Math.min(length - copied, current.length - chunkOffset);
      current.copy(out, copied, chunkOffset, chunkOffset + take);
      copied += take;
      chunkOffset = 0;
    }
    return out;
  }

  private consume(length: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length - this.offset >= length) {
      const slice = first.subarray(this.offset, this.offset + length);
      this.offset += length;
      this.totalBytes -= length;
      if (this.offset === first.length) {
        this.chunks.shift();
        this.offset = 0;
      }
      return slice;
    }
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const current = this.chunks[0]!;
      const available = current.length - this.offset;
      const take = Math.min(length - copied, available);
      current.copy(out, copied, this.offset, this.offset + take);
      copied += take;
      this.totalBytes -= take;
      if (take === available) {
        this.chunks.shift();
        this.offset = 0;
      } else {
        this.offset += take;
      }
    }
    return out;
  }
}
