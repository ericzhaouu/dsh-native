import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createIsolatedCompletion } from "../dist/native/isolated.js";
import { createNativeHarness } from "../dist/native/harness.js";
import { createDshRuntime } from "../dist/runtime.js";
import { parseDshConfig } from "../dist/config.js";
import { startModelServer } from "./fixtures/model-server.mjs";

const stateRoot = () => resolve("artifacts", `native-isolated-${randomUUID()}`);

function model(overrides = {}) {
  return {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 4096,
    ...overrides,
  };
}

function params(overrides = {}) {
  const prepared = model(overrides.model);
  return {
    provider: prepared.provider,
    modelId: prepared.id,
    model: prepared,
    authorization: {
      owner: "host",
      model: prepared,
      auth: { apiKey: "secret-host-key", source: "profile", mode: "api-key" },
      sourceAuthFingerprint: "fingerprint",
    },
    config: {},
    agentId: "main",
    agentDir: resolve("artifacts", "agent"),
    workspaceDir: process.cwd(),
    systemPrompt: "system prompt",
    prompt: "user prompt",
    timeoutMs: 1000,
    outputTextPolicy: "strict-visible",
    streamParams: { maxTokens: 100 },
    assertCurrent() {},
    ...overrides,
  };
}

function route(input) {
  return {
    provider: input.provider,
    modelId: input.model.id,
    apiKey: input.resolvedApiKey,
    baseUrl: input.model.baseUrl,
    contextWindow: input.model.contextWindow,
    maxTokens: input.streamParams?.maxTokens ?? input.model.maxTokens,
    thinking: input.thinkLevel === "off" ? "disabled" : "enabled",
    reasoningEffort: "high",
  };
}

async function withService(t, runtimeFactory, run) {
  const root = stateRoot();
  await mkdir(root, { recursive: true });
  const config = {
    stateDir: root,
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    streamIdleTimeoutMs: 100,
    allowedBaseUrls: ["https://api.deepseek.com"],
  };
  const service = createIsolatedCompletion(config, route, { runtimeFactory, now: () => 1234 });
  try { await run({ service, root }); }
  finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("isolated completion uses a fresh zero-tool private runtime call and cleans successful state", async (t) => {
  const calls = [];
  const configs = [];
  await withService(t, (cfg) => {
    configs.push(cfg);
    return {
      async run(input) {
        calls.push(input);
        return {
          text: "Native answer",
          sessionId: input.sessionId,
          usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 },
          contextUsage: { state: "available", promptTokens: 15, totalTokens: 16 },
          stopReason: "stop",
          toolCalls: 0,
        };
      },
      async compact() { throw new Error("unexpected compact"); },
      async dispose() {},
    };
  }, async ({ service, root }) => {
    const result = await service.run(params());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, "user prompt");
    assert.equal(calls[0].systemPrompt, "system prompt");
    assert.deepEqual(calls[0].tools, []);
    assert.equal("taskPreparation" in calls[0], false);
    assert.match(calls[0].sessionId, /^isolated-/);
    assert.match(calls[0].nativeStateId, /^isolated-state-/);
    assert.notEqual(calls[0].sessionId, "canonical-session");
    assert.equal(configs[0].stateDir.startsWith(join(root, "isolated-")), true);
    await assert.rejects(stat(configs[0].stateDir), /ENOENT/);
    assert.deepEqual(result.assistant.content, [{ type: "text", text: "Native answer" }]);
    assert.equal(result.assistant.provider, "deepseek");
    assert.equal(result.assistant.model, "deepseek-v4-pro");
    assert.equal(result.assistant.usage.totalTokens, 16);
    assert.deepEqual(result.assistant.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.deepEqual(await readdir(root), []);
  });
});

test("external cancellation aborts the runtime without publishing a success", async (t) => {
  const abort = new AbortController();
  let seenSignal;
  await withService(t, () => ({
    async run(input) {
      seenSignal = input.signal;
      const aborted = new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      abort.abort(new Error("owner cancelled"));
      return aborted;
    },
    async compact() { throw new Error("unexpected compact"); },
    async dispose() {},
  }), async ({ service, root }) => {
    await assert.rejects(service.run(params({ abortSignal: abort.signal })), /owner cancelled/);
    assert.equal(seenSignal.aborted, true);
    const leftovers = await readdir(root);
    assert.equal(leftovers.length, 1, "failed isolated state is preserved for investigation");
  });
});

test("rejects mismatched model authority and harness-owned auth plans before runtime creation", async (t) => {
  let factories = 0;
  await withService(t, () => {
    factories += 1;
    throw new Error("runtime must not be created");
  }, async ({ service }) => {
    await assert.rejects(service.run(params({ modelId: "alias" })), /logical provider\/model/);
    await assert.rejects(service.run(params({
      authorization: { owner: "harness", plan: {}, authProfileStore: {} },
    })), /harness-owned authentication/);
    assert.equal(factories, 0);
  });
});

test("rejects runtime tool attempts and aborted completions", async (t) => {
  await withService(t, () => ({
    async run(input) {
      return {
        text: "bad",
        sessionId: input.sessionId,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        toolCalls: 1,
      };
    },
    async compact() { throw new Error("unexpected compact"); },
    async dispose() {},
  }), async ({ service }) => {
    await assert.rejects(service.run(params()), /tools/);
  });
  await withService(t, () => ({
    async run(input) {
      return {
        text: "bad",
        sessionId: input.sessionId,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "aborted",
        toolCalls: 0,
      };
    },
    async compact() { throw new Error("unexpected compact"); },
    async dispose() {},
  }), async ({ service }) => {
    await assert.rejects(service.run(params()), /did not complete/);
  });
});

test("does not serialize isolated context fields into the prompt surface", async (t) => {
  let captured;
  await withService(t, () => ({
    async run(input) {
      captured = input;
      return {
        text: "ok",
        sessionId: input.sessionId,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "length",
        toolCalls: 0,
      };
    },
    async compact() { throw new Error("unexpected compact"); },
    async dispose() {},
  }), async ({ service }) => {
    const p = params({ prompt: "summarize context", systemPrompt: "system" });
    await service.run(p);
    assert.equal(captured.prompt.includes("secret-host-key"), false);
    assert.equal(captured.systemPrompt.includes("secret-host-key"), false);
    assert.equal("authorization" in captured, false);
    assert.equal("authProfileStore" in captured, false);
    assert.equal("sourceAuthFingerprint" in captured, false);
    assert.equal(captured.apiKey, "secret-host-key");
  });
});

test("public isolated completion runs real DSH without touching foreground history", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-iso-"));
  const server = await startModelServer(({ body, send, finish, index }) => {
    assert.deepEqual(body.tools ?? [], []);
    if (index === 1) assert.equal(JSON.stringify(body.messages).includes("FOREGROUND-PRIVATE-MARKER"), false);
    send({ role: "assistant", content: index === 0 ? "FOREGROUND" : "ISOLATED" });
    finish();
  });
  const config = parseDshConfig({ stateDir: root, allowedBaseUrls: [server.baseUrl] });
  const runtime = createDshRuntime(config);
  const harness = createNativeHarness(config, runtime);
  try {
    await runtime.run({
      sessionId: "foreground", runId: "foreground-1", workspaceDir: root,
      systemPrompt: "Text only.", prompt: "FOREGROUND-PRIVATE-MARKER",
      modelId: "deepseek-v4-pro", apiKey: "fixture-only-key", baseUrl: server.baseUrl,
      contextWindow: 1000000, maxTokens: 1000, thinking: "disabled",
      tools: [], signal: new AbortController().signal, assertActive() {}, onEvent() {},
      executeTool: async () => assert.fail("No tools are allowed"),
    });
    const binding = join(root, createHash("sha256").update("foreground").digest("hex"), "binding.json");
    const before = await readFile(binding, "utf8");
    const prepared = model({ baseUrl: server.baseUrl });
    const result = await harness.runIsolatedCompletionV2(params({
      authorization: { owner: "host", model: prepared, auth: { apiKey: "fixture-only-key", mode: "api-key", source: "profile" } },
      thinkLevel: "off", workspaceDir: root, timeoutMs: 60000,
    }));
    assert.equal(result.assistant.content[0].text, "ISOLATED");
    assert.equal(await readFile(binding, "utf8"), before);
    assert.equal(server.requests.length, 2);
    assert.equal((await readdir(root)).some((name) => name.startsWith("isolated-")), false);
  } finally {
    await harness.dispose();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
