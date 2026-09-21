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
import ts from "typescript";

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
const limits = { timeout: 15_000, concurrency: false };
const usage = {
  "deepseek-official": { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 7, total_tokens: 23 },
  "github-copilot": { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 7 }, total_tokens: 23 },
};
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const methods = (h) => h.calls.map(({ method }) => method);
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function opening(provider) {
  return provider === "deepseek-official" ? "" :
    frame({ type: "response.created", response: { id: "r", status: "in_progress", output: [] } }) +
    frame({
      type: "response.output_item.added", output_index: 0,
      item: { id: "m", type: "message", role: "assistant", content: [] },
    });
}
function delta(provider, text = "hello") {
  return frame(provider === "deepseek-official" ? {
    id: "chat", object: "chat.completion.chunk", model: "deepseek-chat",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  } : {
    type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: text,
  });
}
function trailer(provider) {
  return provider === "deepseek-official" ?
    frame({ id: "chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    frame({ id: "chat", choices: [], usage: usage[provider] }) + "data: [DONE]\n\n" :
    frame({
      type: "response.completed",
      response: { id: "r", object: "response", status: "completed", output: [], usage: usage[provider] },
    });
}
function headers(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.flushHeaders();
}
function assertNoTerminal(chunks) {
  assert.deepEqual(chunks.filter(({ type }) => ["usage", "finish"].includes(type)), []);
}
async function collect(stream, visible = []) {
  for await (const chunk of stream) visible.push(chunk);
  return visible;
}

async function harness(t, provider, { handler, rpc, idle = 2_000 } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const requests = [];
  const failures = [];
  const serverErrors = [];
  const cleanups = [];
  let guard;
  let ctx;
  let reservation = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const entry = { body: JSON.parse(Buffer.concat(chunks).toString()), response };
      requests.push(entry);
      if (handler) await handler(response, requests.length);
      else { headers(response); response.end(opening(provider) + delta(provider) + trailer(provider)); }
    })().catch((error) => { serverErrors.push(error); response.destroy(); });
  });
  t.after(async () => {
    guard?.dispose();
    assert.equal(globalThis.fetch, originalFetch);
    for (const cleanup of cleanups) await cleanup();
    if (ctx) await ctx.fiber.dispose();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    assert.deepEqual(serverErrors, []);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  let adapter;
  if (provider === "deepseek-official") {
    const connection = resolveAdapterOptions({
      baseURL, maxTokens: 96, thinking: "disabled", streamIdleTimeoutMs: idle,
      retryPolicy: { mode: "normal", maxRetries: 0 },
    });
    adapter = new DeepSeekAdapter({
      options: () => connection, resolveApiKey: async () => "local-test-key",
      resolveUserId: () => "budget-streaming-test",
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
  } else {
    ctx = new Context();
    ctx.provide("credentials", { resolve: async () => ({ value: "local-test-key" }) });
    await ctx.plugin(LlmRuntime).await();
    await ctx.plugin(PiAi, {
      providers: {
        "github-copilot": {
          api: "openai-responses", baseURL, apiKeyEnv: "BUDGET_STREAMING_TEST_KEY",
          models: [{ id: "budget-test-model", input: ["text"], contextWindow: 8192, maxTokens: 96 }],
          transport: "sse", timeoutMs: 10_000, streamIdleTimeoutMs: idle,
          retryPolicy: { mode: "normal", maxRetries: 0 },
        },
      },
    }).await();
    adapter = ctx.llm.adapters.get(provider)?.adapter;
    assert.ok(adapter instanceof PiAi.PiAiAdapter);
  }
  const options = {
    provider, model: provider === "deepseek-official" ? "deepseek-chat" : "budget-test-model",
    maxTokens: 80, messages: [createUserMessage({ content: [{ type: "text", text: "Hello." }] })],
  };
  guard = new ProviderBudgetGuard({
    operationalBudget: true, budgetBaseUrl: baseURL, budgetMaxTokens: 64,
  }, {
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      const result = await rpc?.(method, params);
      if (result !== undefined) return result;
      return method === "budget.reserve" ? { requestId: `request-${++reservation}`, maxTokens: 12 } : {};
    },
  }, (error) => failures.push(error));
  return {
    guard, adapter, options, requests, calls, failures, cleanups,
    stream(next = () => adapter.stream(options)) { return guard.stream(options, next); },
    fetch() {
      return fetch(`${baseURL}/${provider === "deepseek-official" ? "chat/completions" : "responses"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, stream: true, max_tokens: 80 }),
      });
    },
  };
}

async function assertFenced(h, error) {
  assert.equal(error?.code, "DSH_BUDGET_UNCERTAIN");
  assert.deepEqual(h.failures, [error]);
  assert.throws(() => h.guard.assertHealthy(), (value) => value === error);
  const before = [h.requests.length, h.calls.length];
  await assert.rejects(collect(h.stream()), (value) => value === error);
  assert.deepEqual([h.requests.length, h.calls.length], before);
}

for (const provider of providers) {
  test(`${provider}: max-output terminal usage still settles successfully with the authoritative parser`, limits, async (t) => {
    const ending = provider === "deepseek-official" ? trailer(provider).replace('"stop"', '"length"') :
      frame({
        type: "response.incomplete",
        response: {
          id: "r", object: "response", status: "incomplete", output: [], usage: usage[provider],
          incomplete_details: { reason: "max_output_tokens" },
        },
      });
    const h = await harness(t, provider, {
      handler: (response) => { headers(response); response.end(opening(provider) + delta(provider) + ending); },
    });
    const visible = await collect(h.stream());
    assert.ok(visible.some(({ type }) => type === "finish"));
    assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
    assert.deepEqual(h.failures, []);
  });

  test(`${provider}: periodic real adapter progress outlives idle timeout; settle requires HTTP EOF`, limits, async (t) => {
    const terminalSent = deferred();
    const idle = 400;
    let ended = false;
    let started;
    const h = await harness(t, provider, {
      idle,
      handler: async (response) => {
        started = Date.now();
        headers(response);
        response.write(opening(provider));
        for (let i = 0; i < 14; i++) {
          response.write(delta(provider, `${i} `));
          await delay(60);
          if (response.destroyed) return terminalSent.resolve(response);
        }
        response.write(trailer(provider));
        terminalSent.resolve(response);
      },
      rpc: (method) => { if (method === "budget.settle") assert.equal(ended, true); },
    });
    const visible = [];
    const done = outcome(collect(h.stream(), visible));
    const response = await terminalSent.promise;
    assert.equal(response.destroyed, false, "live deltas must keep the installed watchdog alive");
    assert.ok(Date.now() - started > idle * 2);
    assert.ok(visible.filter(({ type }) => type === "text-delta").length >= 12);
    assertNoTerminal(visible);
    assert.deepEqual(methods(h), ["budget.reserve"]);
    await delay(40);
    ended = true;
    response.end();
    assert.equal((await done).error, undefined);
    assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
    assert.deepEqual(h.calls[1].params, {
      requestId: "request-1", usage: { input: 13, output: 3, cacheRead: 7, cacheWrite: 0 },
    });
    assert.ok(visible.some(({ type }) => type === "finish"));
    assert.equal(h.requests.length, 1);
    h.guard.assertHealthy();
  });

  test(`${provider}: terminal trailer gates next request until late EOF AND settlement ack`, limits, async (t) => {
    const written = deferred();
    const settling = deferred();
    const ack = deferred();
    const progress = deferred();
    const h = await harness(t, provider, {
      handler: (response, index) => {
        headers(response);
        response.write(opening(provider) + delta(provider) + trailer(provider));
        if (index === 1) written.resolve(response);
        else response.end();
      },
      rpc: (method, params) => {
        if (method === "budget.settle" && params.requestId === "request-1") {
          settling.resolve();
          return ack.promise;
        }
      },
    });
    h.cleanups.push(() => ack.resolve({}));
    const visible = [];
    const done = outcome(collect(h.stream(async function* () {
      for (let i = 0; i < 2; i++) {
        for await (const chunk of h.adapter.stream(h.options)) {
          if (chunk.type === "text-delta") progress.resolve();
          yield chunk;
        }
      }
    }), visible));
    const response = await written.promise;
    await progress.promise;
    await delay(50);
    assertNoTerminal(visible);
    assert.deepEqual(methods(h), ["budget.reserve"]);
    assert.equal(h.requests.length, 1);
    response.end();
    await settling.promise;
    await delay(30);
    assertNoTerminal(visible);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
    ack.resolve({});
    assert.equal((await done).error, undefined);
    assert.equal(visible.filter(({ type }) => type === "finish").length, 2);
    assert.deepEqual(methods(h), ["budget.reserve", "budget.settle", "budget.reserve", "budget.settle"]);
  });

  for (const terminal of [false, true]) {
    test(`${provider}: early consumer stop ${terminal ? "after wire terminal" : "midstream"} cancels HTTP and awaits uncertain ack`, limits, async (t) => {
      const closed = deferred();
      const reporting = deferred();
      const ack = deferred();
      const h = await harness(t, provider, {
        handler: (response) => {
          response.once("close", () => closed.resolve());
          headers(response);
          response.write(opening(provider) + delta(provider) + (terminal ? trailer(provider) : ""));
        },
        rpc: (method) => {
          if (method === "budget.uncertain") { reporting.resolve(); return ack.promise; }
        },
      });
      h.cleanups.push(() => ack.resolve({}));
      let returned = false;
      const done = outcome((async () => {
        try {
          for await (const chunk of h.stream()) if (chunk.type === "text-delta") break;
        } finally { returned = true; }
      })());
      await reporting.promise;
      await closed.promise;
      assert.equal(returned, false, "consumer return must await actual pump cleanup and parent RPC");
      assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
      ack.resolve({});
      const { error } = await done;
      await assertFenced(h, error);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.calls[1].params, { requestId: "request-1" });
    });
  }

  test(`${provider}: idle after terminal before EOF aborts real HTTP without settlement or second request`, limits, async (t) => {
    const closed = deferred();
    const h = await harness(t, provider, {
      idle: 250,
      handler: (response) => {
        response.once("close", () => closed.resolve());
        headers(response);
        response.write(opening(provider) + delta(provider) + trailer(provider));
      },
    });
    let second = false;
    const visible = [];
    const { error } = await outcome(collect(h.stream(async function* () {
      yield* h.adapter.stream(h.options);
      second = true;
      yield* h.adapter.stream(h.options);
    }), visible));
    await closed.promise;
    assertNoTerminal(visible);
    assert.equal(second, false);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
    await assertFenced(h, error);
  });

  for (const ending of ["reset", "missing terminal", "invalid usage", "data after terminal"]) {
    test(`${provider}: ${ending} after live progress remains uncertain even if adapter failure is swallowed`, limits, async (t) => {
      const progress = deferred();
      const ack = deferred();
      const reporting = deferred();
      const h = await harness(t, provider, {
        handler: async (response) => {
          headers(response);
          response.write(opening(provider) + delta(provider));
          await progress.promise;
          if (ending === "reset") response.destroy();
          else if (ending === "missing terminal") response.end();
          else if (ending === "invalid usage") response.end(trailer(provider).replace(/"total_tokens":23/u, '"total_tokens":24'));
          else response.end(trailer(provider) + delta(provider, "illegal late text"));
        },
        rpc: (method) => {
          if (method === "budget.uncertain") { reporting.resolve(); return ack.promise; }
        },
      });
      h.cleanups.push(() => { progress.resolve(); ack.resolve({}); });
      let completed = false;
      const visible = [];
      const done = outcome(collect(h.stream(async function* () {
        try {
          for await (const chunk of h.adapter.stream(h.options)) {
            if (chunk.type === "text-delta") progress.resolve();
            yield chunk;
          }
        } catch { /* Exercise adapters/wrappers that swallow transport failures. */ }
      }), visible).finally(() => { completed = true; }));
      await reporting.promise;
      await delay(20);
      assert.equal(completed, false);
      assertNoTerminal(visible);
      assert.ok(visible.some(({ type }) => type === "text-delta"));
      ack.resolve({});
      const { error } = await done;
      assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
      await assertFenced(h, error);
    });
  }
}

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`raw SSE framing preserves split UTF-8 and ${JSON.stringify(newline)} delimiters without leaking trailer`, limits, async (t) => {
    const written = deferred();
    const progress = deferred();
    const provider = "deepseek-official";
    const prefix = `\uFEFF: heartbeat\n\n${delta(provider, "你好")}`.replace(/\n/gu, newline);
    const ending = trailer(provider).replace(/\n/gu, newline);
    const h = await harness(t, provider, {
      handler: async (response) => {
        headers(response);
        const bytes = Buffer.from(prefix + ending);
        for (let i = 0; i < bytes.length; i++) {
          response.write(bytes.subarray(i, i + 1));
          await delay(1);
        }
        written.resolve(response);
      },
    });
    let visible = "";
    const done = outcome(collect(h.stream(async function* () {
      const response = await h.fetch();
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        visible += decoder.decode(bytes, { stream: true });
        if (visible.includes("你好")) progress.resolve();
      }
      visible += decoder.decode();
    })));
    const response = await written.promise;
    await progress.promise;
    assert.equal(visible, prefix.replace(/^\uFEFF/u, ""));
    assert.deepEqual(methods(h), ["budget.reserve"]);
    response.end();
    assert.equal((await done).error, undefined);
    assert.equal(visible, (prefix + ending).replace(/^\uFEFF/u, ""));
    assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
  });
}

test("raw reader cancellation awaits pump/uncertain RPC and never rejects an ignored cancel promise", limits, async (t) => {
  const ack = deferred();
  const reporting = deferred();
  const h = await harness(t, "deepseek-official", {
    handler: (response) => { headers(response); response.write(delta("deepseek-official")); },
    rpc: (method) => {
      if (method === "budget.uncertain") { reporting.resolve(); return ack.promise; }
    },
  });
  h.cleanups.push(() => ack.resolve({}));
  let cancelled = false;
  let completed = false;
  const done = outcome(collect(h.stream(async function* () {
    const response = await h.fetch();
    const reader = response.body.getReader();
    await reader.read();
    void reader.cancel("consumer stopped").then(() => { cancelled = true; });
  })).finally(() => { completed = true; }));
  await reporting.promise;
  assert.equal(cancelled, false);
  assert.equal(completed, false);
  ack.resolve({});
  const { error } = await done;
  assert.equal(cancelled, true);
  await assertFenced(h, error);
});

test("scope completion after headers cancels an unread pump and awaits uncertain reporting", limits, async (t) => {
  const reporting = deferred();
  const ack = deferred();
  const h = await harness(t, "deepseek-official", {
    handler: (response) => { headers(response); response.write(delta("deepseek-official")); },
    rpc: (method) => {
      if (method === "budget.uncertain") { reporting.resolve(); return ack.promise; }
    },
  });
  h.cleanups.push(() => ack.resolve({}));
  let completed = false;
  const done = outcome(collect(h.stream(async function* () { await h.fetch(); }))
    .finally(() => { completed = true; }));
  await reporting.promise;
  assert.equal(completed, false);
  ack.resolve({});
  const { error } = await done;
  await assertFenced(h, error);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
});

test("concurrent fetch after headers is fenced while the original body pump is still live", limits, async (t) => {
  const h = await harness(t, "deepseek-official", {
    handler: (response) => { headers(response); response.write(delta("deepseek-official")); },
  });
  const { error } = await outcome(collect(h.stream(async function* () {
    const response = await h.fetch();
    await h.fetch().catch(() => {});
    try { await response.text(); } catch { /* Guard must still propagate its failure. */ }
  })));
  await assertFenced(h, error);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
});

test("a fetch inheriting a closed ALS scope cannot reserve or dispatch a late attempt", limits, async (t) => {
  const trigger = deferred();
  let late;
  const h = await harness(t, "deepseek-official");
  await collect(h.stream(async function* () {
    late = outcome((async () => { await trigger.promise; return h.fetch(); })());
    yield* h.adapter.stream(h.options);
  }));
  assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
  trigger.resolve();
  const { error } = await late;
  await assertFenced(h, error);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
});

test("scope closure during reserve waits its acknowledgement, reports uncertainty, and never dispatches", limits, async (t) => {
  const reserving = deferred();
  const grant = deferred();
  const h = await harness(t, "deepseek-official", {
    rpc: (method) => {
      if (method === "budget.reserve") { reserving.resolve(); return grant.promise; }
    },
  });
  h.cleanups.push(() => grant.resolve({ requestId: "late-grant", maxTokens: 12 }));
  let completed = false;
  const done = outcome(collect(h.stream(async function* () {
    void h.fetch();
    await reserving.promise;
  })).finally(() => { completed = true; }));
  await reserving.promise;
  await delay(20);
  assert.equal(completed, false);
  grant.resolve({ requestId: "late-grant", maxTokens: 12 });
  const { error } = await done;
  await assertFenced(h, error);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.calls.at(-1), { method: "budget.uncertain", params: { requestId: "late-grant" } });
});

test("cancellation during settlement fences immediately and drains both settle and uncertain acknowledgements", limits, async (t) => {
  const settling = deferred();
  const settleAck = deferred();
  const reporting = deferred();
  const uncertainAck = deferred();
  const h = await harness(t, "deepseek-official", {
    rpc: (method) => {
      if (method === "budget.settle") { settling.resolve(); return settleAck.promise; }
      if (method === "budget.uncertain") { reporting.resolve(); return uncertainAck.promise; }
    },
  });
  h.cleanups.push(() => { settleAck.resolve({}); uncertainAck.resolve({}); });
  let visible = "";
  let cancelled = false;
  let completed = false;
  const done = outcome(collect(h.stream(async function* () {
    const response = await h.fetch();
    const reader = response.body.getReader();
    visible += new TextDecoder().decode((await reader.read()).value);
    await settling.promise;
    void reader.cancel().then(() => { cancelled = true; });
    await h.fetch().catch(() => {});
  })).finally(() => { completed = true; }));
  await settling.promise;
  await delay(20);
  assert.equal(cancelled, false);
  assert.equal(completed, false);
  assert.throws(() => h.guard.assertHealthy(), { code: "DSH_BUDGET_UNCERTAIN" });
  assert.deepEqual(methods(h), ["budget.reserve", "budget.settle"]);
  assert.doesNotMatch(visible, /"finish_reason":"stop"|"usage"|\[DONE\]/u);
  settleAck.resolve({});
  await reporting.promise;
  assert.equal(completed, false);
  assert.equal(cancelled, false);
  uncertainAck.resolve({});
  const { error } = await done;
  assert.equal(cancelled, true);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.settle", "budget.uncertain"]);
  await assertFenced(h, error);
});

test("raw validation caps the entire response at 32 MiB, including bytes held after terminal", limits, async (t) => {
  const progress = deferred();
  const h = await harness(t, "deepseek-official", {
    handler: async (response) => {
      headers(response);
      response.write(delta("deepseek-official"));
      await progress.promise;
      response.write(trailer("deepseek-official"));
      response.end(`:${"x".repeat(32 * 1024 * 1024)}\n\n`);
    },
  });
  h.cleanups.push(() => progress.resolve());
  const visible = [];
  const { error } = await outcome(collect(h.stream(async function* () {
    for await (const chunk of h.adapter.stream(h.options)) {
      if (chunk.type === "text-delta") progress.resolve();
      yield chunk;
    }
  }), visible));
  assertNoTerminal(visible);
  assert.match(error?.cause?.message ?? "", /response body too large/u);
  assert.deepEqual(methods(h), ["budget.reserve", "budget.uncertain"]);
  await assertFenced(h, error);
});
