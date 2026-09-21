import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { BridgeBudgetConfig } from "./budget-config.js";
import { parseBridgeConfig } from "./budget-config.js";
import { terminalBudgetUsage } from "./budget-usage.js";
import { emptyParams, keys, positiveInteger, record } from "./validation.js";

interface BudgetPeer {
  request(method: string, params: unknown): Promise<unknown>;
}

interface Scope {
  options: GenerateOptions;
  controller: AbortController;
  open: boolean;
  pending: Set<Promise<unknown>>;
  attempts: number;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
let installed: ProviderBudgetGuard | undefined;

function uncertain(message: string, cause?: unknown): Error {
  return Object.assign(new Error(`DSH_BUDGET_UNCERTAIN: ${message}`, { cause }), { code: "DSH_BUDGET_UNCERTAIN" });
}

function startsTrailer(bytes: Uint8Array, responses: boolean): boolean {
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/gu, "\n").split("\n");
  const terminalTypes = ["response.completed", "response.incomplete", "response.failed", "error"];
  if (responses && lines.some((line) => line.startsWith("event:") && terminalTypes.includes(line.slice(6).trim()))) return true;
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
  if (!data) return false;
  if (data === "[DONE]") return true;
  const event = record(JSON.parse(data), "provider SSE event");
  if (event.error !== undefined || event.usage != null) return true;
  return responses ? terminalTypes.includes(String(event.type)) :
    Array.isArray(event.choices) && event.choices.some((value) => record(value, "provider choice").finish_reason != null);
}

/** Child-only transport gate. The parent reserves full contextWindow input, never a tokenizer estimate. */
export class ProviderBudgetGuard {
  private readonly config: BridgeBudgetConfig;
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly stop = new AbortController();
  private readonly originalFetch = globalThis.fetch;
  private readonly requests = new Set<string>();
  private failure?: Error;
  private busy = false;
  private disposed = false;

  constructor(config: BridgeBudgetConfig, private readonly peer: BudgetPeer, private readonly onFailure: (error: Error) => void) {
    this.config = parseBridgeConfig(config)!;
    if (installed) throw uncertain("a child transport gate is already installed");
    installed = this;
    globalThis.fetch = this.fetch;
  }

  private latch(error: unknown): Error {
    if (!this.failure) {
      this.failure = error instanceof Error ? error : uncertain("budget RPC failed", error);
      this.stop.abort(this.failure);
      this.onFailure(this.failure);
    }
    return this.failure;
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
    if (this.disposed || globalThis.fetch !== this.fetch) throw this.latch(uncertain("transport gate replaced or disposed"));
  }

  cancel(): void {
    this.stop.abort(uncertain("operation cancelled"));
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    if (globalThis.fetch === this.fetch) globalThis.fetch = this.originalFetch;
    if (installed === this) installed = undefined;
  }

  /** Scope eager SDK creation AND each lazy iterator advance, including maintenance calls. */
  async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    this.assertHealthy();
    if (!["deepseek-official", "github-copilot"].includes(options.provider)) {
      throw this.latch(uncertain("unmetered provider transport"));
    }
    const scope: Scope = { options, controller: new AbortController(), open: true, pending: new Set(), attempts: 0 };
    let iterator: AsyncIterator<StreamChunk> | undefined;
    let exhausted = false;
    try {
      iterator = this.scope.run(scope, () => next()[Symbol.asyncIterator]());
      while (true) {
        const item = await this.scope.run(scope, () => iterator!.next());
        this.assertHealthy();
        if (item.done) {
          exhausted = true;
          return;
        }
        yield item.value;
      }
    } catch (error) {
      throw this.failure ?? error;
    } finally {
      scope.open = false;
      scope.controller.abort();
      try {
        if (!exhausted) await this.scope.run(scope, () => iterator?.return?.());
      } finally {
        // Fetch headers and the body pump have independent lifetimes. Drain even
        // when an adapter swallows a body error or returns without consuming it.
        while (scope.pending.size) await Promise.allSettled([...scope.pending]);
        this.assertHealthy();
        if (exhausted && !scope.attempts) throw this.latch(uncertain("provider bypassed the transport gate"));
      }
    }
  }

  private readonly fetch: typeof fetch = (input, init) => {
    const scope = this.scope.getStore();
    return this.track(scope, this.attempt(scope, input, init));
  };

  private track<T>(scope: Scope | undefined, pending: Promise<T>): Promise<T> {
    scope?.pending.add(pending);
    void pending.then(() => scope?.pending.delete(pending), () => scope?.pending.delete(pending));
    return pending;
  }

  private async attempt(scope: Scope | undefined, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    let requestId: string | undefined;
    let ownsAttempt = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let controller: AbortController | undefined;
    let pump: Promise<void> | undefined;
    let cancelling: Promise<void> | undefined;
    const cancelBody = (reason: unknown) => {
      if (reader) cancelling ??= reader.cancel(reason).catch(() => {});
      return cancelling;
    };
    const fail = async (error: unknown): Promise<never> => {
      const failure = this.latch(uncertain("provider attempt has unknown settlement", error));
      controller?.abort(failure);
      await cancelBody(failure);
      if (requestId) {
        try { emptyParams(await this.peer.request("budget.uncertain", { requestId })); } catch { /* Parent retains the reservation. */ }
      }
      throw failure;
    };
    const release = () => {
      reader?.releaseLock();
      if (ownsAttempt) this.busy = false;
    };
    try {
      this.assertHealthy();
      if (!scope?.open || this.busy || this.stop.signal.aborted) throw uncertain("unowned, overlapping, or cancelled attempt");
      this.busy = ownsAttempt = true;
      if (typeof init?.body !== "string") throw uncertain("unsupported provider request body transport");
      const request = new Request(input, init);
      const responses = scope.options.provider === "github-copilot";
      const endpoint = `${this.config.budgetBaseUrl}${responses ? "/responses" : "/chat/completions"}`;
      if (request.url !== endpoint || request.method !== "POST" ||
          request.headers.get("content-encoding") || (init && ("dispatcher" in init || "agent" in init))) {
        throw uncertain("unapproved provider endpoint or transport");
      }
      const payload = await request.text();
      if (Buffer.byteLength(payload) > MAX_BODY_BYTES) throw uncertain("provider request body too large");
      const body = record(JSON.parse(payload), "provider request");
      if (body.model !== scope.options.model || body.stream !== true || (body.n !== undefined && body.n !== 1) ||
          body.max_completion_tokens !== undefined || body.background === true) {
        throw uncertain("unsupported provider request shape");
      }
      let maxTokens = this.config.budgetMaxTokens;
      if (scope.options.maxTokens !== undefined) maxTokens = Math.min(maxTokens, positiveInteger(scope.options.maxTokens, "maxTokens"));
      for (const field of ["max_tokens", "max_output_tokens"]) {
        if (body[field] !== undefined) maxTokens = Math.min(maxTokens, positiveInteger(body[field], field));
      }
      controller = new AbortController();
      const signal = AbortSignal.any([
        request.signal, this.stop.signal, scope.controller.signal, controller.signal,
        ...(scope.options.signal ? [scope.options.signal] : []),
      ]);
      signal.throwIfAborted();
      // No I/O before this durable acknowledgement. Input is reserved by the parent,
      // using its prepared contextWindow; the child never supplies an input estimate.
      const grant = record(await this.peer.request("budget.reserve", { maxTokens })
        .catch((error: unknown) => { throw this.latch(error); }), "budget reservation");
      if (typeof grant.requestId === "string" && grant.requestId.trim()) requestId = grant.requestId;
      keys(grant, ["requestId", "maxTokens"], "budget reservation");
      const allowed = positiveInteger(grant.maxTokens, "reserved maxTokens");
      if (!requestId || this.requests.has(requestId) || allowed > maxTokens) throw uncertain("invalid budget reservation");
      this.requests.add(requestId);
      signal.throwIfAborted();
      this.assertHealthy();
      body[responses ? "max_output_tokens" : "max_tokens"] = allowed;
      for (const field of ["max_tokens", "max_output_tokens"]) {
        if (body[field] !== undefined) body[field] = Math.min(positiveInteger(body[field], field), allowed);
      }
      if (!responses) body.stream_options = { ...record(body.stream_options ?? {}, "stream_options"), include_usage: true };
      const headers = new Headers(request.headers);
      const payloadBytes = Buffer.from(JSON.stringify(body));
      headers.set("content-length", String(payloadBytes.byteLength));
      // Native fetch can replay a string body internally on HTTP 421, below this
      // gate. A one-shot stream has no replayable body.source, disabling that hop.
      const transport: RequestInit & { duplex: "half" } = {
        method: "POST", headers, signal, redirect: "error", duplex: "half",
        body: new ReadableStream<Uint8Array>({
          start(output) { output.enqueue(payloadBytes); output.close(); },
        }),
      };
      scope.attempts++;
      const response = await this.originalFetch(request.url, transport);
      if (!response.body) throw uncertain("provider response has no body");
      reader = response.body.getReader();
      if (!response.ok || response.redirected ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
        throw uncertain("failed or unsupported provider response");
      }
      let output!: ReadableStreamDefaultController<Uint8Array>;
      const bodyStream = new ReadableStream<Uint8Array>({
        start(value) { output = value; },
        cancel: (reason) => {
          controller!.abort(uncertain("provider response consumer stopped", reason));
          // The pump owns failure reporting; cancellation must not create a
          // second rejected promise in SDKs that discard reader.cancel().
          return pump?.then(() => {}, () => {});
        },
      });
      const resultHeaders = new Headers(response.headers);
      resultHeaders.delete("content-encoding");
      resultHeaders.delete("content-length");
      const result = new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: resultHeaders });
      const onAbort = () => {
        this.latch(uncertain("provider response aborted before completion", signal.reason));
        void cancelBody(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pump = this.track(scope, (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        let forwarded = 0;
        let held = false;
        let parts: Uint8Array[] = [];
        let lineLength = 0;
        let afterCR = false;
        let frameEnded = false;
        const forward = (chunk: Uint8Array, eof = false) => {
          let start = 0;
          const emit = (end: number) => {
            parts.push(chunk.subarray(start, end));
            const frame = Buffer.concat(parts);
            held = startsTrailer(frame, responses);
            if (!held) {
              output.enqueue(frame);
              forwarded += frame.byteLength;
            }
            parts = [];
            start = end;
            frameEnded = false;
          };
          // Recognize LF, CRLF and CR across arbitrary HTTP/UTF-8 splits.
          for (let index = 0; index < chunk.byteLength && !held; index++) {
            const byte = chunk[index];
            if (afterCR) {
              afterCR = false;
              if (byte === 10) {
                if (frameEnded) emit(index + 1);
                continue;
              }
              if (frameEnded) {
                emit(index);
                if (held) break;
              }
            }
            if (byte === 13 || byte === 10) {
              frameEnded = lineLength === 0;
              lineLength = 0;
              if (byte === 13) afterCR = true;
              else if (frameEnded) emit(index + 1);
            } else lineLength++;
          }
          if (!held && start < chunk.byteLength) parts.push(chunk.subarray(start));
          if (!held && eof && frameEnded) emit(chunk.byteLength);
        };
        try {
          signal.throwIfAborted();
          while (true) {
            const chunk = await reader!.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_BODY_BYTES) throw uncertain("provider response body too large");
            chunks.push(chunk.value);
            if (!held) forward(chunk.value);
          }
          forward(new Uint8Array(), true);
          const bytes = Buffer.concat(chunks, size);
          const usage = terminalBudgetUsage(new TextDecoder("utf-8", { fatal: true }).decode(bytes), responses);
          signal.throwIfAborted();
          emptyParams(await this.peer.request("budget.settle", { requestId, usage })
            .catch((error: unknown) => { throw this.latch(error); }));
          signal.throwIfAborted();
          this.assertHealthy();
          requestId = undefined;
          // Only real HTTP EOF plus the parent's acknowledgement releases the
          // trailer; SDK [DONE]/finish handling can no longer settle a live body.
          output.enqueue(bytes.subarray(forwarded));
          output.close();
        } catch (error) {
          try {
            await fail(error);
          } catch (failure) {
            output.error(failure);
            throw failure;
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          if (cancelling) await cancelling;
          release();
        }
      })());
      return result;
    } catch (error) {
      return await fail(error);
    } finally {
      if (!pump) release();
    }
  }
}
