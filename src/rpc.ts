import type { Readable, Writable } from "node:stream";
import { isRecord } from "./protocol.js";

interface PeerOptions {
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  maxQueuedNotifications?: number;
  maxQueuedWrites?: number;
  maxQueuedWriteBytes?: number;
  maxInboundRequests?: number;
  maxQueuedReadBytes?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface QueuedWrite {
  bytes: Buffer;
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
}

interface QueuedNotification {
  method: string;
  params: unknown;
  frameBytes: number;
}

interface InboundRequest {
  id: number;
  method: string;
  params: unknown;
  frameBytes: number;
}

/** Private, bounded JSON-RPC transport; this is not the ACP protocol. */
export class JsonRpcPeer {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly pending = new Map<number, Pending>();
  private readonly maxFrameBytes: number;
  private readonly maxPendingRequests: number;
  private readonly maxQueuedNotifications: number;
  private readonly maxQueuedWrites: number;
  private readonly maxQueuedWriteBytes: number;
  private readonly maxInboundRequests: number;
  private readonly maxQueuedReadBytes: number;
  private queuedReadBytes = 0;
  private sequence = 0;
  private readChunks: Buffer[] = [];
  private readBufferedBytes = 0;
  private failure?: Error;
  private protocolFailure?: Error;
  private writeQueue: QueuedWrite[] = [];
  private activeWrite?: QueuedWrite;
  private queuedWriteBytes = 0;
  private writeFailure?: Error;
  private notificationQueue: QueuedNotification[] = [];
  private notificationActive = false;
  private notificationFailure?: Error;
  private drainWaiters: Pending[] = [];
  private inboundQueue: InboundRequest[] = [];
  private inboundActive = 0;
  private inputEnded = false;
  private outputFinished = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: PeerOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024;
    this.maxPendingRequests = options.maxPendingRequests ?? 128;
    this.maxQueuedNotifications = options.maxQueuedNotifications ?? 1024;
    this.maxQueuedWrites = options.maxQueuedWrites ?? 256;
    this.maxQueuedWriteBytes = options.maxQueuedWriteBytes ?? 32 * 1024 * 1024;
    this.maxInboundRequests = options.maxInboundRequests ?? 64;
    this.maxQueuedReadBytes = options.maxQueuedReadBytes ?? 32 * 1024 * 1024;
    for (const [name, value] of Object.entries({
      maxFrameBytes: this.maxFrameBytes, maxPendingRequests: this.maxPendingRequests,
      maxQueuedNotifications: this.maxQueuedNotifications, maxQueuedWrites: this.maxQueuedWrites,
      maxQueuedWriteBytes: this.maxQueuedWriteBytes, maxInboundRequests: this.maxInboundRequests,
      maxQueuedReadBytes: this.maxQueuedReadBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid DSH bridge ${name} limit.`);
    }
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onInputClose);
    input.on("error", this.onError);
    output.on("finish", this.onOutputFinish);
    output.on("close", this.onOutputClose);
    output.on("error", this.onError);
  }

  get failureReason(): Error | undefined {
    return this.failure;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= this.maxPendingRequests) {
      const error = new Error("DSH bridge pending request limit exceeded.");
      this.fail(error);
      return Promise.reject(error);
    }
    const id = ++this.sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void this.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
      this.close(asError(error));
    });
    return result;
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  async drain(): Promise<void> {
    if (this.protocolFailure) throw this.protocolFailure;
    if (this.writeFailure) throw this.writeFailure;
    if (this.notificationFailure) throw this.notificationFailure;
    if (this.failure && (this.activeWrite || this.writeQueue.length || this.notificationActive || this.notificationQueue.length)) {
      throw this.failure;
    }
    if (!this.activeWrite && this.writeQueue.length === 0 && !this.notificationActive && this.notificationQueue.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      this.drainWaiters.push({ resolve, reject });
    });
    if (this.protocolFailure) throw this.protocolFailure;
    if (this.writeFailure) throw this.writeFailure;
    if (this.notificationFailure) throw this.notificationFailure;
  }

  close(error = new Error("DSH bridge connection closed."), options: { fatal?: boolean } = {}): void {
    if (options.fatal) this.protocolFailure ??= error;
    if (this.failure) return;
    this.failure = error;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onInputClose);
    this.output.off("finish", this.onOutputFinish);
    this.output.off("close", this.onOutputClose);
    // Streams can report a late write error after EOF; retain their error sink.
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.readChunks = [];
    this.readBufferedBytes = 0;
    this.rejectWrites(error);
    this.notificationQueue = [];
    if (this.notificationActive) this.notificationFailure ??= error;
    this.inboundQueue = [];
    this.resolveDrainWaiters(error);
    this.resolveClosed();
  }

  private readonly onEnd = (): void => {
    this.inputEnded = true;
    if (this.readBufferedBytes) this.fail(new Error("Truncated DSH bridge frame."));
    else this.close(new Error("DSH bridge reached EOF."));
  };

  private readonly onError = (error: Error): void => { this.fail(error); };

  private readonly onInputClose = (): void => {
    if (!this.failure && !this.inputEnded) this.fail(new Error("DSH bridge input closed."));
  };

  private readonly onOutputFinish = (): void => { this.outputFinished = true; };

  private readonly onOutputClose = (): void => {
    if (!this.failure && !this.outputFinished) this.fail(new Error("DSH bridge output closed."));
  };

  private fail(error: Error): void {
    this.protocolFailure ??= error;
    this.close(error);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.failure) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !this.failure) {
      const newline = bytes.indexOf(10, offset);
      const end = newline >= 0 ? newline : bytes.length;
      const segment = bytes.subarray(offset, end);
      this.readChunks.push(segment);
      this.readBufferedBytes += segment.length;
      if (this.readBufferedBytes > this.maxFrameBytes) {
        this.fail(new Error("DSH bridge frame exceeds the configured limit."));
        return;
      }
      if (newline < 0) return;
      const line = this.readChunks.length === 1 ? this.readChunks[0]! : Buffer.concat(this.readChunks, this.readBufferedBytes);
      this.readChunks = [];
      this.readBufferedBytes = 0;
      offset = newline + 1;
      if (line.length === 0) continue;
      try {
        this.receive(JSON.parse(line.toString("utf8")), line.length);
      } catch (error: unknown) {
        this.fail(new Error("Invalid DSH bridge frame.", { cause: error }));
        return;
      }
    }
  };

  private receive(message: unknown, frameBytes: number): void {
    if (!isRecord(message) || message.jsonrpc !== "2.0") throw new Error("Expected JSON-RPC 2.0.");
    if (typeof message.method === "string") {
      const method = message.method;
      if (this.queuedReadBytes + frameBytes > this.maxQueuedReadBytes) {
        this.fail(new Error("DSH bridge incoming queue byte limit exceeded."));
        return;
      }
      if (message.id === undefined) {
        this.enqueueNotification(method, message.params, frameBytes);
        return;
      }
      if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
        throw new Error("Invalid request id.");
      }
      this.enqueueInboundRequest({ id: message.id, method, params: message.params, frameBytes });
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      throw new Error("Invalid response id.");
    }
    const pending = this.pending.get(message.id);
    if (!pending) throw new Error("Unexpected DSH bridge response id.");
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      if (!isRecord(message.error) || typeof message.error.message !== "string") {
        pending.reject(new Error("Malformed DSH bridge error."));
        throw new Error("Malformed error response.");
      }
      pending.reject(new Error(message.error.message));
    } else if ("result" in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error("Missing DSH bridge response result."));
      throw new Error("Missing response result.");
    }
  }

  private enqueueNotification(method: string, params: unknown, frameBytes: number): void {
    if (this.failure) return;
    if (this.notificationQueue.length + (this.notificationActive ? 1 : 0) >= this.maxQueuedNotifications) {
      this.fail(new Error("DSH bridge notification queue limit exceeded."));
      return;
    }
    this.queuedReadBytes += frameBytes;
    this.notificationQueue.push({ method, params, frameBytes });
    this.pumpNotifications();
  }

  private pumpNotifications(): void {
    if (this.notificationActive || this.failure) return;
    const next = this.notificationQueue.shift();
    if (!next) {
      this.resolveDrainWaiters();
      return;
    }
    this.notificationActive = true;
    void (async () => {
      try {
        await this.options.onNotification?.(next.method, next.params);
      } catch (error: unknown) {
        this.notificationFailure ??= asError(error);
        this.fail(asError(error));
      } finally {
        this.queuedReadBytes -= next.frameBytes;
        this.notificationActive = false;
        if (!this.failure) this.pumpNotifications();
        else this.notificationQueue = [];
        this.resolveDrainWaiters();
      }
    })();
  }

  private enqueueInboundRequest(request: InboundRequest): void {
    if (this.failure) return;
    if (this.inboundActive + this.inboundQueue.length >= this.maxInboundRequests) {
      this.fail(new Error("DSH bridge inbound request limit exceeded."));
      return;
    }
    this.inboundQueue.push(request);
    this.queuedReadBytes += request.frameBytes;
    this.pumpInboundRequests();
  }

  private pumpInboundRequests(): void {
    while (!this.failure && this.inboundActive < this.maxInboundRequests) {
      const request = this.inboundQueue.shift();
      if (!request) return;
      this.inboundActive++;
      void this.handleInboundRequest(request).finally(() => {
        this.inboundActive--;
        this.queuedReadBytes -= request.frameBytes;
        this.pumpInboundRequests();
      });
    }
  }

  private async handleInboundRequest({ id, method, params }: InboundRequest): Promise<void> {
    try {
      if (!this.options.onRequest) throw new Error(`Unsupported bridge method: ${method}`);
      const result = await this.options.onRequest(method, params);
      if (this.failure) return;
      await this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error: unknown) {
      if (this.failure) return;
      try {
        await this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: asError(error).message } });
      } catch (sendError: unknown) {
        this.fail(asError(sendError));
      }
    }
  }

  private send(message: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let json: string | undefined;
    try {
      if (estimateJsonBytes(message, this.maxFrameBytes) > this.maxFrameBytes - 1) {
        throw new Error("Outgoing DSH bridge frame too large.");
      }
      json = JSON.stringify(message);
      if (json === undefined) throw new Error("Outgoing DSH bridge frame is not JSON.");
    } catch (error) { return Promise.reject(asError(error)); }
    const bytes = Buffer.from(json + "\n");
    if (bytes.length > this.maxFrameBytes) return Promise.reject(new Error("Outgoing DSH bridge frame too large."));
    if (this.writeQueue.length + (this.activeWrite ? 1 : 0) >= this.maxQueuedWrites ||
        this.queuedWriteBytes + bytes.length > this.maxQueuedWriteBytes) {
      const error = new Error("DSH bridge write queue limit exceeded.");
      this.fail(error);
      return Promise.reject(error);
    }
    this.queuedWriteBytes += bytes.length;
    const write = new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ bytes, resolve, reject, settled: false });
    });
    this.pumpWrites();
    return write;
  }

  private pumpWrites(): void {
    if (this.activeWrite || this.failure) return;
    const write = this.writeQueue.shift();
    if (!write) {
      this.resolveDrainWaiters();
      return;
    }
    this.activeWrite = write;
    const completed = (error?: Error | null) => {
      if (error) {
        this.protocolFailure ??= error;
        this.writeFailure ??= error;
      }
      if (!write.settled) {
        this.queuedWriteBytes -= write.bytes.length;
        write.settled = true;
        if (error) write.reject(error);
        else write.resolve();
      }
      if (this.activeWrite === write) this.activeWrite = undefined;
      if (error) this.fail(error);
      if (!this.failure) this.pumpWrites();
      this.resolveDrainWaiters();
    };
    try { this.output.write(write.bytes, completed); }
    catch (error) { completed(asError(error)); }
  }

  private rejectWrites(error: Error): void {
    const writes = [...(this.activeWrite ? [this.activeWrite] : []), ...this.writeQueue];
    this.writeQueue = [];
    this.activeWrite = undefined;
    if (writes.length) this.writeFailure ??= error;
    for (const write of writes) {
      if (!write.settled) {
        this.queuedWriteBytes -= write.bytes.length;
        write.settled = true;
        write.reject(error);
      }
    }
  }

  private resolveDrainWaiters(error?: Error): void {
    if (!error && (this.activeWrite || this.writeQueue.length || this.notificationActive || this.notificationQueue.length)) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    const failure = error ?? this.protocolFailure ?? this.writeFailure ?? this.notificationFailure;
    for (const waiter of waiters) {
      if (failure) waiter.reject(failure);
      else waiter.resolve(undefined);
    }
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function estimateJsonBytes(value: unknown, limit: number, depth = 0, seen = new Set<object>()): number {
  if (depth > 64) return limit + 1;
  if (value === null) return 4;
  switch (typeof value) {
    case "string":
      if (value.length > limit - 2) return limit + 1;
      return Buffer.byteLength(JSON.stringify(value));
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "undefined":
    case "function":
    case "symbol":
      return 4;
    case "bigint":
      return limit + 1;
    case "object":
      break;
  }
  if (seen.has(value)) return limit + 1;
  seen.add(value);
  let total = 2;
  if (Array.isArray(value)) {
    if (value.length > limit) return limit + 1;
    for (let index = 0; index < value.length; index++) {
      total += index === 0 ? 0 : 1;
      total += estimateJsonBytes(value[index], limit - total, depth + 1, seen);
      if (total > limit) return total;
    }
    seen.delete(value);
    return total;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (typeof descriptors.toJSON?.value === "function") return limit + 1;
  let count = 0;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) return limit + 1;
    total += count++ === 0 ? 0 : 1;
    total += Buffer.byteLength(JSON.stringify(key)) + 1;
    total += estimateJsonBytes(descriptor.value, limit - total, depth + 1, seen);
    if (total > limit) return total;
  }
  seen.delete(value);
  return total;
}
