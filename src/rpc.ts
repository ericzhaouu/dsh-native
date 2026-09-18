import type { Readable, Writable } from "node:stream";
import { isRecord } from "./protocol.js";

interface PeerOptions {
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  maxFrameBytes?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Private, bounded JSON-RPC transport; this is not the ACP protocol. */
export class JsonRpcPeer {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly pending = new Map<number, Pending>();
  private readonly maxFrameBytes: number;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private failure?: Error;
  private protocolFailure?: Error;
  private writes: Promise<void> = Promise.resolve();
  private notifications: Promise<void> = Promise.resolve();
  private inputEnded = false;
  private outputFinished = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: PeerOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024;
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
    await this.notifications;
    await this.writes;
    if (this.protocolFailure) throw this.protocolFailure;
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
    this.buffer = Buffer.alloc(0);
    this.resolveClosed();
  }

  private readonly onEnd = (): void => {
    this.inputEnded = true;
    if (this.buffer.length) this.fail(new Error("Truncated DSH bridge frame."));
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
    this.buffer = Buffer.concat([this.buffer, bytes]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > this.maxFrameBytes) {
        this.fail(new Error("DSH bridge frame exceeds the configured limit."));
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      try {
        this.receive(JSON.parse(line.toString("utf8")));
      } catch (error: unknown) {
        this.fail(new Error("Invalid DSH bridge frame.", { cause: error }));
        return;
      }
    }
    if (this.buffer.length > this.maxFrameBytes) {
      this.fail(new Error("DSH bridge frame exceeds the configured limit."));
    }
  };

  private receive(message: unknown): void {
    if (!isRecord(message) || message.jsonrpc !== "2.0") throw new Error("Expected JSON-RPC 2.0.");
    if (typeof message.method === "string") {
      const method = message.method;
      if (message.id === undefined) {
        this.notifications = this.notifications.then(() => this.options.onNotification?.(method, message.params));
        void this.notifications.catch((error: unknown) => this.fail(asError(error)));
        return;
      }
      if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
        throw new Error("Invalid request id.");
      }
      const id = message.id;
      void (async () => {
        try {
          if (!this.options.onRequest) throw new Error(`Unsupported bridge method: ${method}`);
          const result = await this.options.onRequest(method, message.params);
          await this.send({ jsonrpc: "2.0", id, result: result ?? null });
        } catch (error: unknown) {
          await this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: asError(error).message } });
        }
      })().catch((error: unknown) => this.fail(asError(error)));
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

  private send(message: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const bytes = Buffer.from(JSON.stringify(message) + "\n");
    if (bytes.length > this.maxFrameBytes) return Promise.reject(new Error("Outgoing DSH bridge frame too large."));
    const write = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      this.output.write(bytes, (error) => error ? reject(error) : resolve());
    }));
    this.writes = write;
    return write;
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
