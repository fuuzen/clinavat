import type { Duplex } from 'node:stream';
import {
  ClientDisconnectedError, createAbortError, encodeFrame, FrameDecoder, FrameType,
  MAX_FRAME_PAYLOAD_BYTES, MuxStreamImpl, ProtocolError, RpcError,
  type DecodedFrame, type FrameTypeCode, type MuxStream, type RpcCallOptions,
  type RpcErrorPayload, type RpcRequestHandler,
} from './framing.js';

export {
  ClientDisconnectedError, encodeFrame, FRAME_HEADER_SIZE, FrameDecoder, FrameType,
  MAX_FRAME_PAYLOAD_BYTES, ProtocolError, RpcError,
  type DecodedFrame, type FrameTypeCode, type MuxStream, type RpcCallOptions,
  type RpcErrorPayload, type RpcRequestContext, type RpcRequestHandler,
} from './framing.js';

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_STREAM_ID = 0x7fffffff;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface DrainWaiter {
  promise: Promise<void>;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class Multiplexer {
  private readonly decoder: FrameDecoder;
  private readonly maxPayloadBytes: number;
  private readonly defaultRpcTimeoutMs: number;
  private readonly pendingRpcs = new Map<number, PendingRpc>();
  private readonly incomingRpcs = new Map<number, AbortController>();
  private readonly streams = new Map<number, MuxStreamImpl>();
  private readonly handlers = new Map<string, RpcRequestHandler>();
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private drainWaiter?: DrainWaiter;
  private nextIdCounter = 1;
  private closed = false;
  private closeError?: Error;

  private readonly onTransportData = (chunk: Buffer | string) => {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const frame of this.decoder.push(buffer)) this.dispatchFrame(frame);
    } catch (error) {
      const failure = error instanceof Error ? error : new ProtocolError(String(error));
      this.failTransport(failure);
      // Use argumentless destroy() with a fallback error guard so bare net.Socket teardown never throws uncaught errors.
      if (!this.transport.destroyed) this.transport.destroy();
    }
  };
  private readonly onTransportClose = () => this.failTransport(new ClientDisconnectedError('客户端连接已关闭'));
  private readonly onTransportEnd = () => this.failTransport(new ClientDisconnectedError('客户端流已结束'));
  private readonly onTransportError = (error: Error) => this.failTransport(new ClientDisconnectedError(`客户端传输错误：${error.message}`));

  constructor(private readonly transport: Duplex, options?: { defaultRpcTimeoutMs?: number; maxPayloadBytes?: number }) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? MAX_FRAME_PAYLOAD_BYTES;
    this.defaultRpcTimeoutMs = options?.defaultRpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.decoder = new FrameDecoder(this.maxPayloadBytes);
    this.transport.on('data', this.onTransportData);
    this.transport.once('close', this.onTransportClose);
    this.transport.once('end', this.onTransportEnd);
    this.transport.on('error', this.onTransportError);
  }

  get isClosed(): boolean { return this.closed; }

  registerHandler(method: string, handler: RpcRequestHandler): () => void {
    this.handlers.set(method, handler);
    return () => { if (this.handlers.get(method) === handler) this.handlers.delete(method); };
  }

  onClose(listener: (reason?: Error) => void): () => void {
    if (this.closed) { listener(this.closeError); return () => undefined; }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  async writeFrame(frameType: FrameTypeCode, streamId: number, payload: Buffer = Buffer.alloc(0)): Promise<void> {
    if (this.closed) throw this.closeError ?? new ClientDisconnectedError();
    if (payload.length > this.maxPayloadBytes) throw new ProtocolError(`发送帧载荷超出上限 (${payload.length} > ${this.maxPayloadBytes})`);
    while (this.drainWaiter) {
      await this.drainWaiter.promise;
      if (this.closed) throw this.closeError ?? new ClientDisconnectedError();
    }
    const ready = this.transport.write(encodeFrame(frameType, streamId, payload));
    if (!ready && !this.closed) {
      this.ensureDrainWaiter();
      await this.drainWaiter!.promise;
    }
  }

  callRpc<T = unknown>(method: string, params?: unknown, options?: RpcCallOptions): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new ClientDisconnectedError());
    if (options?.signal?.aborted) return Promise.reject(createAbortError(options.signal.reason));
    const id = this.allocateId();
    const timeoutMs = options?.timeoutMs ?? this.defaultRpcTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        options?.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (err?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.pendingRpcs.delete(id);
        if (err) reject(err);
        else resolve(value as T);
      };
      const onAbort = () => {
        void this.writeFrame(FrameType.STREAM_CANCEL, id).catch(() => undefined);
        finish(createAbortError(options?.signal?.reason));
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          void this.writeFrame(FrameType.STREAM_CANCEL, id).catch(() => undefined);
          finish(new RpcError('RPC_TIMEOUT', `客户端 RPC 调用超时 (${method})`));
        }, timeoutMs);
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingRpcs.set(id, { resolve: value => finish(undefined, value), reject: err => finish(err) });
      const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
      this.writeFrame(FrameType.RPC_REQUEST, id, payload).catch(err => finish(err instanceof Error ? err : new Error(String(err))));
    });
  }

  async openStream(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<MuxStream> {
    if (this.closed) throw this.closeError ?? new ClientDisconnectedError();
    if (signal?.aborted) throw createAbortError(signal.reason);
    const streamId = this.allocateId();
    const stream = this.createStream(streamId);
    try {
      stream.initialResult = await this.callRpc(method, { ...(params ?? {}), streamId }, { signal });
      stream.bindAbortSignal(signal);
      return stream;
    } catch (error) {
      stream.terminate(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  attachStream(streamId: number): MuxStream {
    if (this.closed) throw this.closeError ?? new ClientDisconnectedError();
    return this.streams.get(streamId) ?? this.createStream(streamId);
  }

  close(reason?: string): void {
    this.failTransport(new ClientDisconnectedError(reason || '客户端连接已关闭'));
    if (!this.transport.destroyed) this.transport.destroy();
  }

  private allocateId(): number {
    for (let attempt = 0; attempt < 1024; attempt++) {
      const candidate = this.nextIdCounter;
      this.nextIdCounter = candidate >= MAX_STREAM_ID ? 1 : candidate + 1;
      if (!this.pendingRpcs.has(candidate) && !this.streams.has(candidate)) return candidate;
    }
    throw new ProtocolError('无法分配空闲的流 ID');
  }

  private createStream(streamId: number): MuxStreamImpl {
    const stream = new MuxStreamImpl(streamId, this, () => {
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId);
    });
    this.streams.set(streamId, stream);
    return stream;
  }

  private ensureDrainWaiter(): void {
    if (this.drainWaiter) return;
    let resolveFn!: () => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    const onDrain = () => { const waiter = this.drainWaiter; this.drainWaiter = undefined; waiter?.cleanup(); resolveFn(); };
    this.transport.once('drain', onDrain);
    this.drainWaiter = { promise, reject: rejectFn, cleanup: () => this.transport.off('drain', onDrain) };
  }

  private dispatchFrame(frame: DecodedFrame): void {
    if (frame.frameType === FrameType.RPC_REQUEST) return this.handleRpcRequest(frame.streamId, frame.payload);
    if (frame.frameType === FrameType.RPC_RESPONSE) return this.handleRpcResponse(frame.payload);
    if (frame.frameType === FrameType.STREAM_DATA) return void this.streams.get(frame.streamId)?.handleData(frame.payload);
    if (frame.frameType === FrameType.STREAM_EOF) {
      let meta: unknown;
      if (frame.payload.length > 0) { try { meta = JSON.parse(frame.payload.toString('utf8')); } catch { meta = undefined; } }
      return void this.streams.get(frame.streamId)?.handleEof(meta);
    }
    this.handleCancel(frame.streamId, frame.payload);
  }

  private handleRpcRequest(streamId: number, payload: Buffer): void {
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try { req = JSON.parse(payload.toString('utf8')) as { id?: unknown; method?: unknown; params?: unknown }; }
    catch { throw new ProtocolError('RPC_REQUEST 负载不是有效 JSON'); }
    if (typeof req.id !== 'number' || !Number.isInteger(req.id) || typeof req.method !== 'string') {
      throw new ProtocolError('RPC_REQUEST 缺少有效的 id 或 method');
    }
    const id = req.id;
    const handler = this.handlers.get(req.method);
    if (!handler) { void this.sendRpcError(id, 'METHOD_NOT_FOUND', `未注册的方法：${req.method}`); return; }
    const controller = new AbortController();
    this.incomingRpcs.set(id, controller);
    let execution: Promise<unknown>;
    try {
      execution = Promise.resolve(handler(req.params, { id, streamId, signal: controller.signal }));
    } catch (err) {
      execution = Promise.reject(err);
    }
    execution
      .then(result => {
        this.incomingRpcs.delete(id);
        if (this.closed || controller.signal.aborted) return;
        return this.writeFrame(FrameType.RPC_RESPONSE, id, Buffer.from(JSON.stringify({ id, result: result ?? null }), 'utf8'));
      })
      .catch(err => {
        this.incomingRpcs.delete(id);
        if (this.closed || controller.signal.aborted) return;
        return this.sendRpcError(id, err instanceof RpcError ? err.code : 'INTERNAL_ERROR',
          err instanceof Error ? err.message : String(err), err instanceof RpcError ? err.data : undefined);
      })
      .catch(() => undefined);
  }

  private handleRpcResponse(payload: Buffer): void {
    let res: { id?: unknown; result?: unknown; error?: RpcErrorPayload };
    try { res = JSON.parse(payload.toString('utf8')) as { id?: unknown; result?: unknown; error?: RpcErrorPayload }; }
    catch { throw new ProtocolError('RPC_RESPONSE 负载不是有效 JSON'); }
    if (typeof res.id !== 'number') return;
    const pending = this.pendingRpcs.get(res.id);
    if (!pending) return;
    if (res.error) pending.reject(new RpcError(res.error.code || 'RPC_ERROR', res.error.message || 'RPC 执行失败', res.error.data));
    else pending.resolve(res.result);
  }

  private handleCancel(streamId: number, payload: Buffer): void {
    let reason = '对端已取消';
    if (payload.length > 0) {
      try {
        const parsed = JSON.parse(payload.toString('utf8')) as { reason?: unknown };
        if (typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason;
      } catch { /* ignore malformed cancel metadata */ }
    }
    const incoming = this.incomingRpcs.get(streamId);
    if (incoming) { this.incomingRpcs.delete(streamId); incoming.abort(new Error(reason)); }
    this.pendingRpcs.get(streamId)?.reject(new RpcError('CANCELLED', reason));
    this.streams.get(streamId)?.terminate(new Error(reason));
  }

  private sendRpcError(id: number, code: string, message: string, data?: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify({ id, error: { code, message, ...(data === undefined ? {} : { data }) } }), 'utf8');
    return this.writeFrame(FrameType.RPC_RESPONSE, id, body);
  }

  private failTransport(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    this.transport.off('data', this.onTransportData);
    this.transport.off('close', this.onTransportClose);
    this.transport.off('end', this.onTransportEnd);
    this.transport.off('error', this.onTransportError);
    if (!this.transport.destroyed) {
      const swallowLateError = () => undefined;
      this.transport.on('error', swallowLateError);
      this.transport.once('close', () => this.transport.off('error', swallowLateError));
    }
    if (this.drainWaiter) { const w = this.drainWaiter; this.drainWaiter = undefined; w.cleanup(); w.reject(error); }
    for (const pending of [...this.pendingRpcs.values()]) pending.reject(error);
    this.pendingRpcs.clear();
    for (const controller of this.incomingRpcs.values()) controller.abort(error);
    this.incomingRpcs.clear();
    for (const stream of [...this.streams.values()]) stream.terminate(error);
    this.streams.clear();
    for (const listener of [...this.closeListeners]) { try { listener(error); } catch { /* isolate */ } }
    this.closeListeners.clear();
  }
}
