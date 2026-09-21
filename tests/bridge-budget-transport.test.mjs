import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DeepSeekAdapter, resolveAdapterOptions } from "@deepseek-ai/dsh-llm-deepseek";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import OpenAI from "openai";
import ts from "typescript";

// Keep transitive imports (including ../protocol.js and ../preparation.js) on source.
const distRoot = new URL("../dist/", import.meta.url);
const srcRoot = new URL("../src/", import.meta.url);
function sourceFor(url) {
  if (!url?.startsWith(distRoot.href) || !url.endsWith(".js")) return undefined;
  const source = new URL(`${url.slice(distRoot.href.length, -3)}.ts`, srcRoot);
  return existsSync(source) ? source : undefined;
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceFor(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const source = sourceFor(url);
    return source ? {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    } : next(url, context);
  },
});
let ProviderBudgetGuard;
try {
  ({ ProviderBudgetGuard } = await import("../dist/bridge/budget.js"));
} finally {
  hooks.deregister();
}

const providers = ["deepseek-official", "github-copilot"];
const wireUsage = {
  "deepseek-official": {
    prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 7,
    prompt_cache_miss_tokens: 13, total_tokens: 23,
  },
  "github-copilot": {
    input_tokens: 20, output_tokens: 3,
    input_tokens_details: { cached_tokens: 7, cache_write_tokens: 4 }, total_tokens: 23,
  },
};
const chargedUsage = {
  "deepseek-official": { input: 13, output: 3, cacheRead: 7, cacheWrite: 0 },
  "github-copilot": { input: 9, output: 3, cacheRead: 7, cacheWrite: 4 },
};
const limits = { timeout: 10_000, concurrency: false };
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
function sse(provider, usage = wireUsage[provider], { omitUsage = false, terminal = true } = {}) {
  if (provider === "deepseek-official") {
    return frame({
      id: "chat-budget", object: "chat.completion.chunk", model: "deepseek-chat",
      choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
    }) + (terminal ? frame({
      id: "chat-budget", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) + (omitUsage ? "" : frame({ id: "chat-budget", choices: [], usage })) + "data: [DONE]\n\n" : "");
  }
  return frame({
    type: "response.created", response: { id: "resp-budget", status: "in_progress", output: [] },
  }) + frame({
    type: "response.output_item.added", output_index: 0,
    item: { id: "msg-budget", type: "message", role: "assistant", content: [] },
  }) + frame({
    type: "response.output_text.delta", item_id: "msg-budget", output_index: 0,
    content_index: 0, delta: "hello",
  }) + (terminal ? frame({
    type: "response.completed",
    response: {
      id: "resp-budget", object: "response", model: "budget-test-model", created_at: 1,
      status: "completed", output: [], ...(omitUsage ? {} : { usage }),
    },
  }) : "");
}
function sendSse(response, text, end = true) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(text);
  if (end) response.end();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
function outcome(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}
function optionsFor(provider, extra = {}) {
  return {
    provider, model: provider === "deepseek-official" ? "deepseek-chat" : "budget-test-model",
    messages: [createUserMessage({ content: [{ type: "text", text: "Say hello." }] })],
    maxTokens: 80, ...extra,
  };
}

async function harness(t, { handler, rpc, grants = [12], budgetMaxTokens = 64 } = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const calls = [];
  const failures = [];
  const serverErrors = [];
  const cleanups = [];
  let reservations = 0;
  let guard;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const entry = {
        method: request.method, url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      requests.push(entry);
      if (handler) await handler(entry, response);
      else sendSse(response, sse(entry.url.endsWith("/responses") ? "github-copilot" : "deepseek-official"));
    })().catch((error) => {
      serverErrors.push(error);
      response.destroy();
    });
  });
  t.after(async () => {
    try {
      guard?.dispose();
      assert.equal(globalThis.fetch, originalFetch, "dispose must restore the real fetch");
    } finally {
      globalThis.fetch = originalFetch;
      try {
        for (const cleanup of cleanups) await cleanup();
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    }
    assert.deepEqual(serverErrors, []);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseURL, requests, calls, failures, cleanups,
    get guard() { return guard; },
    install() {
      guard = new ProviderBudgetGuard({
        operationalBudget: true, budgetBaseUrl: baseURL, budgetMaxTokens,
      }, {
        async request(method, params) {
          calls.push({ method, params: structuredClone(params) });
          if (rpc) {
            const result = await rpc(method, params);
            if (result !== undefined) return result;
          }
          if (method === "budget.reserve") {
            const index = reservations++;
            return { requestId: `request-${index + 1}`, maxTokens: grants[index % grants.length] };
          }
          assert.ok(["budget.settle", "budget.uncertain"].includes(method), method);
          return {};
        },
      }, (error) => failures.push(error));
      return guard;
    },
  };
}

async function adapterFor(h, provider) {
  if (provider === "deepseek-official") {
    const connection = resolveAdapterOptions({
      baseURL: h.baseURL, maxTokens: 96, thinking: "disabled",
      streamIdleTimeoutMs: 3_000, retryPolicy: { mode: "normal", maxRetries: 0 },
    });
    return new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: async () => "local-test-key",
      resolveUserId: () => "budget-transport-test",
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
  }
  const ctx = new Context();
  h.cleanups.push(() => ctx.fiber.dispose());
  ctx.provide("credentials", { resolve: async () => ({ value: "local-test-key" }) });
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(PiAi, {
    providers: {
      "github-copilot": {
        api: "openai-responses", baseURL: h.baseURL, apiKeyEnv: "BUDGET_TRANSPORT_TEST_KEY",
        models: [{ id: "budget-test-model", input: ["text"], contextWindow: 8192, maxTokens: 96 }],
        transport: "sse", timeoutMs: 3_000, streamIdleTimeoutMs: 3_000,
        retryPolicy: { mode: "normal", maxRetries: 0 },
      },
    },
  }).await();
  const adapter = ctx.llm.adapters.get("github-copilot")?.adapter;
  assert.ok(adapter instanceof PiAi.PiAiAdapter, "the installed plugin must register the real adapter");
  return adapter;
}
const methods = (h) => h.calls.map((call) => call.method);
function assertCharged(h, provider, caps = [64]) {
  assert.equal(h.calls.length, caps.length * 2);
  for (const [index, maxTokens] of caps.entries()) {
    assert.deepEqual(h.calls[index * 2], { method: "budget.reserve", params: { maxTokens } });
    assert.deepEqual(h.calls[index * 2 + 1], {
      method: "budget.settle",
      params: { requestId: `request-${index + 1}`, usage: chargedUsage[provider] },
    });
  }
  assert.deepEqual(h.failures, []);
  h.guard.assertHealthy();
}
async function assertFenced(h, adapter, options, error) {
  assert.ok(error instanceof Error);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0], error, "onFailure and the caller must share the latched error");
  assert.throws(() => h.guard.assertHealthy(), (value) => value === error);
  const before = [h.calls.length, h.requests.length];
  let invoked = false;
  await assert.rejects(collect(h.guard.stream(options, () => {
    invoked = true;
    return adapter.stream(options);
  })), (value) => value === error);
  assert.equal(invoked, false, "a fenced retry must not even construct an adapter stream");
  assert.deepEqual([h.calls.length, h.requests.length], before);
}

for (const provider of providers) {
  test(`${provider}: real adapter reserves, clips JSON and settles disjoint raw SSE usage`, limits, async (t) => {
    const h = await harness(t);
    // Construct the adapters before installation; their actual requests must still use the gate.
    const adapter = await adapterFor(h, provider);
    const options = optionsFor(provider);
    h.install();
    const chunks = await collect(h.guard.stream(options, () => adapter.stream(options)));
    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.ok(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello"));
    assertCharged(h, provider);
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.url, `/v1/${provider === "deepseek-official" ? "chat/completions" : "responses"}`);
    assert.equal(request.body.model, options.model);
    assert.equal(request.body.stream, true);
    assert.equal(request.body[provider === "deepseek-official" ? "max_tokens" : "max_output_tokens"], 12);
    if (provider === "deepseek-official") assert.equal(request.body.stream_options.include_usage, true);
  });

  for (const invalid of ["omitted usage", "missing cache-read counter"]) {
    test(`${provider}: refuses ${invalid} instead of charging normalized zeros`, limits, async (t) => {
      const usage = structuredClone(wireUsage[provider]);
      if (provider === "deepseek-official") delete usage.prompt_cache_hit_tokens;
      else delete usage.input_tokens_details.cached_tokens;
      const h = await harness(t, {
        handler: (_request, response) => sendSse(response, sse(provider, usage, {
          omitUsage: invalid === "omitted usage",
        })),
      });
      const adapter = await adapterFor(h, provider);
      const options = optionsFor(provider);
      if (provider === "github-copilot") {
        const normalized = await collect(adapter.stream(options));
        const usageChunk = normalized.find((chunk) => chunk.type === "usage");
        assert.ok(usageChunk, "pi must actually normalize the deficient local response");
        if (invalid === "omitted usage") {
          assert.deepEqual(usageChunk.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        } else {
          assert.deepEqual(usageChunk.usage, {
            inputTokens: 16, outputTokens: 3, totalTokens: 23, cacheWriteTokens: 4,
          });
        }
      }
      const before = h.requests.length;
      h.install();
      const { error } = await outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
      assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
      assert.equal(h.requests.length, before + 1);
      assert.deepEqual(h.calls, [
        { method: "budget.reserve", params: { maxTokens: 64 } },
        { method: "budget.uncertain", params: { requestId: "request-1" } },
      ]);
      await assertFenced(h, adapter, options, error);
    });
  }

  test(`${provider}: usage and finish are not settled or exposed until transport EOF; progress may flow`, limits, async (t) => {
    const written = deferred();
    const h = await harness(t, {
      handler: (_request, response) => {
        sendSse(response, sse(provider), false);
        written.resolve(response);
      },
    });
    const adapter = await adapterFor(h, provider);
    const options = optionsFor(provider);
    h.install();
    const visible = [];
    const completed = outcome((async () => {
      for await (const chunk of h.guard.stream(options, () => adapter.stream(options))) visible.push(chunk);
    })());
    const response = await written.promise;
    await delay(50);
    assert.equal(response.writableEnded, false);
    assert.deepEqual(methods(h), ["budget.reserve"]);
    assert.deepEqual(visible.filter((chunk) => ["usage", "finish"].includes(chunk.type)), [],
      "SDK terminal markers must not leak unaccounted success");
    response.end();
    assert.deepEqual(await completed, { value: undefined });
    assertCharged(h, provider);
    assert.ok(visible.some((chunk) => chunk.type === "finish"));
  });

  for (const ending of ["missing terminal marker", "truncated terminal frame"]) {
    test(`${provider}: normal HTTP EOF with ${ending} is uncertain, not settled`, limits, async (t) => {
      const complete = sse(provider);
      const incomplete = ending === "truncated terminal frame" ? complete.slice(0, -1)
        : provider === "deepseek-official" ? complete.replace("data: [DONE]\n\n", "")
          : sse(provider, wireUsage[provider], { terminal: false });
      const h = await harness(t, {
        handler: (_request, response) => sendSse(response, incomplete),
      });
      const adapter = await adapterFor(h, provider);
      const options = optionsFor(provider);
      h.install();
      const { error } = await outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
      assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.calls, [
        { method: "budget.reserve", params: { maxTokens: 64 } },
        { method: "budget.uncertain", params: { requestId: "request-1" } },
      ]);
      await assertFenced(h, adapter, options, error);
    });
  }

  for (const terminal of [false, true]) {
    test(`${provider}: abort ${terminal ? "after terminal marker before EOF" : "midstream"} stays uncertain`, limits, async (t) => {
      const written = deferred();
      const h = await harness(t, {
        handler: (_request, response) => {
          sendSse(response, sse(provider, wireUsage[provider], { terminal }), false);
          written.resolve();
        },
      });
      const adapter = await adapterFor(h, provider);
      const controller = new AbortController();
      const options = optionsFor(provider, { signal: controller.signal });
      h.install();
      const completed = outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
      await written.promise;
      await delay(25);
      assert.deepEqual(methods(h), ["budget.reserve"]);
      controller.abort(new Error("caller cancelled local stream"));
      const { error } = await completed;
      assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
      assert.deepEqual(h.calls.at(-1), { method: "budget.uncertain", params: { requestId: "request-1" } });
      assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
      assert.equal(h.requests.length, 1);
      await assertFenced(h, adapter, optionsFor(provider), error);
    });
  }

  test(`${provider}: compaction purpose takes the same metered transport path`, limits, async (t) => {
    const h = await harness(t, { grants: [9] });
    const adapter = await adapterFor(h, provider);
    const options = optionsFor(provider, { purpose: "compaction", maxTokens: 19, system: "Summarize the conversation." });
    h.install();
    await collect(h.guard.stream(options, () => adapter.stream(options)));
    assertCharged(h, provider, [19]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body[provider === "deepseek-official" ? "max_tokens" : "max_output_tokens"], 9);
  });

  test(`${provider}: preparation and execution in one scope reserve and clip every real request`, limits, async (t) => {
    const h = await harness(t, { grants: [11, 5] });
    const adapter = await adapterFor(h, provider);
    const preparation = optionsFor(provider, {
      maxTokens: 40, system: "Classify the user's goal and prepare a task before execution.",
      tools: [{
        name: "dsh_prepare_task", description: "Record the semantic preparation decision.",
        parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] },
      }],
    });
    const execution = optionsFor(provider, { maxTokens: 17, system: "Execute the prepared task." });
    h.install();
    const chunks = await collect(h.guard.stream(preparation, async function* () {
      yield* adapter.stream(preparation);
      yield* adapter.stream(execution);
    }));
    assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 2);
    assertCharged(h, provider, [40, 17]);
    assert.equal(h.requests.length, 2);
    const field = provider === "deepseek-official" ? "max_tokens" : "max_output_tokens";
    assert.deepEqual(h.requests.map((request) => request.body[field]), [11, 5]);
    assert.match(JSON.stringify(h.requests[0].body), /dsh_prepare_task/);
    assert.match(JSON.stringify(h.requests[1].body), /Execute the prepared task/);
  });
}

test("reserve acknowledgement precedes network I/O; settlement acknowledgement precedes SDK usage and finish", limits, async (t) => {
  const reserving = deferred();
  const grant = deferred();
  const settling = deferred();
  const settle = deferred();
  t.after(() => { grant.resolve({ requestId: "request-1", maxTokens: 12 }); settle.resolve({}); });
  const h = await harness(t, {
    rpc: async (method) => {
      if (method === "budget.reserve") { reserving.resolve(); return grant.promise; }
      if (method === "budget.settle") { settling.resolve(); return settle.promise; }
    },
  });
  const adapter = await adapterFor(h, "deepseek-official");
  const options = optionsFor("deepseek-official");
  h.install();
  const visible = [];
  const completed = outcome((async () => {
    for await (const chunk of h.guard.stream(options, () => adapter.stream(options))) visible.push(chunk);
  })());
  await reserving.promise;
  await delay(25);
  assert.equal(h.requests.length, 0);
  grant.resolve({ requestId: "request-1", maxTokens: 12 });
  await settling.promise;
  assert.equal(h.requests.length, 1);
  assert.deepEqual(visible.filter((chunk) => ["usage", "finish"].includes(chunk.type)), []);
  settle.resolve({});
  assert.deepEqual(await completed, { value: undefined });
  assertCharged(h, "deepseek-official");
  assert.ok(visible.some((chunk) => chunk.type === "finish"));
});

for (const provider of providers) {
  test(`${provider}: real OpenAI SDK clips both JSON cap fields on every attempt`, limits, async (t) => {
    const h = await harness(t, { grants: [11, 5], budgetMaxTokens: 32 });
    const options = optionsFor(provider, { maxTokens: 25 });
    h.install();
    const client = new OpenAI({ apiKey: "local-test-key", baseURL: h.baseURL, maxRetries: 0 });
    await collect(h.guard.stream(options, async function* () {
      for (const cap of [20, 9]) {
        const body = { model: options.model, stream: true, max_tokens: cap + 1, max_output_tokens: cap };
        yield* await (provider === "deepseek-official"
          ? client.chat.completions.create({ ...body, messages: [{ role: "user", content: "hello" }] })
          : client.responses.create({ ...body, input: "hello" }));
      }
    }));
    assertCharged(h, provider, [20, 9]);
    assert.deepEqual(h.requests.map(({ body }) => [body.max_tokens, body.max_output_tokens]), [[11, 11], [5, 5]]);
  });
}

test("real OpenAI SDK retries cannot send a second HTTP request after an uncertain HTTP failure", limits, async (t) => {
  const h = await harness(t, {
    handler: (_request, response) => {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "local provider unavailable" } }));
    },
  });
  const options = optionsFor("github-copilot");
  h.install();
  const client = new OpenAI({ apiKey: "local-test-key", baseURL: h.baseURL, maxRetries: 2, timeout: 3_000 });
  const fetchCalls = t.mock.method(client, "fetch");
  const next = async function* () {
    yield* await client.responses.create({ model: options.model, input: "hello", stream: true, max_output_tokens: 80 });
  };
  const { error } = await outcome(collect(h.guard.stream(options, next)));
  assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
  assert.equal(fetchCalls.mock.callCount(), 3, "exercise actual SDK retries, not a manual retry loop");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.max_output_tokens, 12);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
  await assertFenced(h, { stream: next }, options, error);
});

for (const method of ["budget.reserve", "budget.settle"]) {
  test(`${method}: preserve the parent's exact error identity through the real adapter`, limits, async (t) => {
    const parentError = Object.assign(new Error(`parent rejected ${method}`), {
      code: "DSH_BUDGET_EXCEEDED", data: { remaining: 0 },
    });
    const h = await harness(t, {
      rpc: async (called) => { if (called === method) throw parentError; },
    });
    const adapter = await adapterFor(h, "deepseek-official");
    const options = optionsFor("deepseek-official");
    h.install();
    const { error } = await outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
    assert.equal(h.requests.length, method === "budget.reserve" ? 0 : 1);
    assert.deepEqual(methods(h), method === "budget.reserve"
      ? ["budget.reserve"] : ["budget.reserve", "budget.settle", "budget.uncertain"]);
    await assertFenced(h, adapter, options, error);
    assert.equal(error, parentError, "budget RPC errors must not be replaced by a transport error");
  });
}

test("malformed parent grant retains its known reservation and never reaches the provider", limits, async (t) => {
  const h = await harness(t, {
    rpc: async (method) => method === "budget.reserve" ? { requestId: "bad-grant", maxTokens: 65 } : undefined,
  });
  const adapter = await adapterFor(h, "deepseek-official");
  const options = optionsFor("deepseek-official");
  h.install();
  const { error } = await outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
  assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.calls.at(-1), { method: "budget.uncertain", params: { requestId: "bad-grant" } });
  await assertFenced(h, adapter, options, error);
});

test("redirect:error forbids a second HTTP hop and leaves the initial reservation uncertain", limits, async (t) => {
  const h = await harness(t, {
    handler: (_request, response) => {
      response.writeHead(307, { location: "/unmetered" });
      response.end();
    },
  });
  const adapter = await adapterFor(h, "deepseek-official");
  const options = optionsFor("deepseek-official");
  h.install();
  const { error } = await outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
  assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
  assert.deepEqual(h.requests.map(({ url }) => url), ["/v1/chat/completions"]);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
  await assertFenced(h, adapter, options, error);
});

for (const suffix of ["/files", "/chat/completions?extra=1", "/responses", "/chat/completions/extra"]) {
  test(`exact prepared endpoint rejects ${suffix} before reservation or network`, limits, async (t) => {
    const h = await harness(t);
    const options = optionsFor("deepseek-official");
    h.install();
    const next = async function* () {
      await fetch(`${h.baseURL}${suffix}`, { method: "POST", body: JSON.stringify({
        model: options.model, stream: true, max_tokens: 80,
      }) });
    };
    const { error } = await outcome(collect(h.guard.stream(options, next)));
    assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.calls, []);
    await assertFenced(h, { stream: next }, options, error);
  });
}

test("native fetch receives a nonreplayable body so HTTP 421 cannot bypass reservation", limits, async (t) => {
  const h = await harness(t, {
    handler: (_request, response) => {
      response.writeHead(421, { "content-type": "application/json" });
      response.end('{"error":{"message":"misdirected"}}');
    },
  });
  const realFetch = globalThis.fetch;
  let rawCalls = 0;
  globalThis.fetch = (url, init) => {
    rawCalls++;
    assert.ok(init.body instanceof ReadableStream);
    assert.equal(init.duplex, "half");
    assert.equal(init.redirect, "error");
    return realFetch(url, init);
  };
  // Restore the probe before the harness verifies its own fetch restoration.
  t.after(() => { globalThis.fetch = realFetch; });
  const options = optionsFor("deepseek-official");
  const adapter = await adapterFor(h, options.provider);
  h.install();
  try {
    const { error } = await outcome(collect(h.guard.stream(options, () => adapter.stream(options))));
    assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
    assert.equal(rawCalls, 1);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
    await assertFenced(h, adapter, options, error);
  } finally {
    h.guard.dispose();
    globalThis.fetch = realFetch;
  }
});
