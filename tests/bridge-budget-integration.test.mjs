import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { createUserMessage, LlmError } from "@deepseek-ai/dsh-llm";
import * as DeepSeek from "@deepseek-ai/dsh-llm-deepseek";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import ts from "typescript";

// Resolve the whole local import graph against source, never stale dist output.
const distRoot = new URL("../dist/", import.meta.url);
const srcRoot = new URL("../src/", import.meta.url);
const loaded = new Set();
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
    if (!source) return next(url, context);
    loaded.add(source.href);
    return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
  },
});
let parseBridgeConfig, auditBudgetProvider, createBridgePatch, BridgeWorker, parseRun, parseCompact;
try {
  ({ parseBridgeConfig } = await import("../dist/bridge/budget-config.js"));
  ({ auditBudgetProvider } = await import("../dist/bridge/budget-provider.js"));
  ({ createBridgePatch, BridgeWorker } = await import("../dist/bridge/index.js"));
  ({ parseRun, parseCompact } = await import("../dist/bridge/validation.js"));
} finally {
  hooks.deregister();
}

const limits = { timeout: 10_000, concurrency: false };
const providers = ["deepseek", "github-copilot"];
const baseUrl = "https://budget-integration.invalid/v1";
const budget = Object.freeze({
  operationalBudget: true, budgetBaseUrl: baseUrl, budgetMaxTokens: 64,
});
const uncertain = { code: "DSH_BUDGET_UNCERTAIN" };
const routeFor = (provider) => provider === "deepseek" ? "deepseek-official" : provider;
function patchOptions(provider, extra = {}) {
  return {
    bridgePath: fileURLToPath(new URL("../dist/bridge/index.js", import.meta.url)),
    baseUrl, thinking: "disabled", maxTokens: 64, contextWindow: 8192,
    streamIdleTimeoutMs: 3_000, provider,
    ...(provider === "github-copilot" ? {
      modelId: "budget-test-model", reasoningEfforts: false,
    } : {}),
    ...extra,
  };
}
function rowsOf(patch) {
  return new Map(patch.flatMap((entry) => entry.insert ?? [entry]).map((entry) => [entry.id, entry]));
}
function runFor(provider = "deepseek", extra = {}) {
  return {
    provider, sessionId: "budget-integration", resume: false,
    workspaceDir: fileURLToPath(new URL("..", import.meta.url)),
    systemPrompt: "", prompt: "Hello", tools: [],
    modelId: provider === "deepseek" ? "deepseek-chat" : "budget-test-model",
    ...extra,
  };
}
function optionsFor(provider, extra = {}) {
  return {
    provider: routeFor(provider), model: runFor(provider).modelId,
    messages: [createUserMessage({ content: [{ type: "text", text: "Hello" }] })],
    ...extra,
  };
}
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function runtimeFor(t, provider, changeConfig = () => {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const credentials = [];
  ctx.provide("credentials", {
    async resolve(ref) {
      credentials.push(ref);
      return { value: "memory-only-test-key" };
    },
  });
  await ctx.plugin(LlmRuntime).await();
  const rows = rowsOf(createBridgePatch(patchOptions(provider)));
  const config = structuredClone(rows.get(provider === "deepseek" ? "llm-deepseek" : "llm-pi-ai").config);
  changeConfig(config);
  await ctx.plugin(provider === "deepseek" ? DeepSeek : PiAi, config).await();
  const route = routeFor(provider);
  assert.ok(ctx.llm.adapters instanceof Map, "inspect the installed runtime's internal registration Map");
  assert.deepEqual([...ctx.llm.adapters.keys()], [route]);
  const registration = ctx.llm.adapters.get(route);
  const adapter = registration.adapter;
  assert.equal(Object.getPrototypeOf(adapter),
    provider === "deepseek" ? DeepSeek.DeepSeekAdapter.prototype : PiAi.PiAiAdapter.prototype);
  return { ctx, llm: ctx.llm, adapter, registration, route, credentials };
}

function workerFor(t, llm, provider, config) {
  const originalFetch = globalThis.fetch;
  const network = [];
  const noNetwork = async (...args) => {
    network.push(args);
    throw new Error("Integration fixtures must not perform provider I/O");
  };
  globalThis.fetch = noNetwork;
  const handlers = new Map();
  const tools = { schemas: () => [] };
  const cancellations = [];
  const agent = { ctx: { tools }, cancel: (reason) => cancellations.push(reason) };
  const loader = { calls: 0, async await() { this.calls++; } };
  const ctx = {
    llm, tools,
    agents: { list: () => [], currentInitiator: () => agent },
    get: (name) => name === "loader" ? loader : undefined,
    on(name, handler, options) { handlers.set(name, { handler, options }); },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  let wire = "";
  output.setEncoding("utf8").on("data", (chunk) => { wire += chunk; });
  const fatal = [];
  const stopped = Promise.withResolvers();
  const worker = new BridgeWorker(ctx, input, output,
    async () => stopped.resolve(), (error) => fatal.push(error), config);
  t.after(async () => {
    try {
      await worker.cleanup();
      worker.peer.close();
      await stopped.promise;
      assert.equal(globalThis.fetch, noNetwork, "cleanup restores the fetch present at construction");
      assert.deepEqual(fatal, []);
      assert.deepEqual(network, []);
    } finally {
      globalThis.fetch = originalFetch;
      input.destroy();
      output.destroy();
    }
  });
  // Seed only run ownership; starting a real agent would activate session persistence.
  worker.request = parseRun(runFor(provider));
  worker.agent = agent;
  worker.armed = true;
  const stream = handlers.get("llm/stream");
  assert.deepEqual(stream.options, { prepend: true });
  return {
    worker, loader, cancellations, noNetwork,
    stream: (options, next) => stream.handler(options, next),
    options: optionsFor(provider, { sessionId: worker.request.sessionId }),
    events: () => wire.trim() ? wire.trim().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

test("integration imports all four bridge modules from current TypeScript source", () => {
  for (const name of ["budget-config", "budget-provider", "profile", "index"]) {
    assert.ok(loaded.has(new URL(`bridge/${name}.ts`, srcRoot).href), name);
  }
});

test("parseBridgeConfig admits only empty legacy config or a complete normalized triple", () => {
  assert.equal(parseBridgeConfig({}), undefined);
  assert.equal(parseBridgeConfig(Object.create(null)), undefined);
  const source = Object.freeze({
    ...budget, budgetBaseUrl: "HTTPS://BUDGET-INTEGRATION.INVALID:443/v1///",
  });
  const parsed = parseBridgeConfig(source);
  assert.deepEqual(parsed, budget);
  assert.notEqual(parsed, source);
  assert.equal(source.budgetBaseUrl, "HTTPS://BUDGET-INTEGRATION.INVALID:443/v1///");
  for (const missing of Object.keys(budget)) {
    const incomplete = { ...budget };
    delete incomplete[missing];
    assert.throws(() => parseBridgeConfig(incomplete), TypeError, missing);
  }
  for (const value of [undefined, null, [], true, 1, "{}", new Date(), Object.create({ ...budget })]) {
    assert.throws(() => parseBridgeConfig(value), TypeError);
  }
  for (const value of [
    { operationalBudget: false }, { ...budget, operationalBudget: false },
    { ...budget, operationalBudget: "true" }, { ...budget, unexpected: true },
    { ...budget, maxTokens: 1 }, { ...budget, baseUrl },
  ]) assert.throws(() => parseBridgeConfig(value), TypeError);
});

test("budget configuration refuses unsafe endpoints and non-positive/non-integral token caps", () => {
  for (const value of [
    undefined, "", "/relative", "file:///budget", "ftp://budget.invalid",
    "https://user:secret@budget.invalid", `${baseUrl}?key=x`, `${baseUrl}#fragment`,
  ]) assert.throws(() => parseBridgeConfig({ ...budget, budgetBaseUrl: value }), TypeError, String(value));
  for (const value of [undefined, null, "64", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseBridgeConfig({ ...budget, budgetMaxTokens: value }), TypeError, String(value));
  }
});

for (const provider of providers) {
  test(`${provider}: disabled profile remains legacy and does not infer budget authority`, () => {
    const omitted = createBridgePatch(patchOptions(provider));
    const disabled = createBridgePatch(patchOptions(provider, { operationalBudget: false }));
    assert.deepEqual(disabled, omitted);
    assert.deepEqual(rowsOf(omitted).get("openclaw-bridge").config, {});
    assert.deepEqual(rowsOf(omitted).get("dsh-token-meter").config, {});
    assert.deepEqual(createBridgePatch(patchOptions(provider, {
      budgetBaseUrl: "https://untrusted.invalid", budgetMaxTokens: 9999,
      model: { operationalBudget: true }, run: { ...budget },
    })), omitted, "model/run-like inputs cannot implicitly enable the parent-owned switch");
  });

  test(`${provider}: enabled patch changes only the bridge row to the trusted budget triple`, () => {
    const options = patchOptions(provider, { baseUrl: `${baseUrl}///`, maxTokens: 41 });
    const expected = createBridgePatch(options);
    const config = { ...budget, budgetMaxTokens: 41 };
    rowsOf(expected).get("openclaw-bridge").config = config;
    const actual = createBridgePatch({
      ...options, operationalBudget: true,
      budgetBaseUrl: "https://untrusted.invalid", budgetMaxTokens: 9999,
      model: { budgetBaseUrl: "https://untrusted.invalid", maxTokens: 9999 },
      run: { operationalBudget: false, maxTokens: 9999 },
    });
    assert.deepEqual(rowsOf(actual).get("openclaw-bridge").config, config);
    assert.deepEqual(actual, expected, "no budget fields belong on token-meter or adapter rows");
    assert.deepEqual(parseBridgeConfig(rowsOf(actual).get("openclaw-bridge").config), config);
  });

  test(`${provider}: budget-enabled patch requires an explicit positive prepared maxTokens`, () => {
    for (const maxTokens of [undefined, 0, -1, 1.5, Infinity]) {
      assert.throws(() => createBridgePatch(patchOptions(provider, { operationalBudget: true, maxTokens })));
    }
    assert.throws(() => createBridgePatch(patchOptions(provider, { operationalBudget: "true" })), TypeError);
  });
}

test("run and maintenance arguments cannot enable, disable, or replace trusted budget config", () => {
  const run = runFor();
  const compact = {
    provider: run.provider, sessionId: run.sessionId, workspaceDir: run.workspaceDir,
    modelId: run.modelId, runId: "compact-budget",
  };
  assert.doesNotThrow(() => parseRun({ ...run, maxTokens: 4096 }));
  assert.doesNotThrow(() => parseCompact({ ...compact, maxTokens: 4096 }));
  for (const [field, value] of [
    ["operationalBudget", true], ["operationalBudget", false],
    ["budgetBaseUrl", "https://untrusted.invalid"], ["budgetMaxTokens", 9999],
    ["model", { ...budget }], ["budget", { ...budget }],
  ]) {
    assert.throws(() => parseRun({ ...run, [field]: value }), /Unexpected run field/);
    assert.throws(() => parseCompact({ ...compact, [field]: value }), /Unexpected compact field/);
  }
});

for (const provider of providers) {
  test(`${provider}: audit is asynchronous and accepts the actual profile's installed plugin`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const pending = auditBudgetProvider(h.llm, budget);
    assert.ok(pending instanceof Promise);
    const validate = await pending;
    assert.equal(typeof validate, "function");
    const options = optionsFor(provider);
    const before = structuredClone(options);
    assert.equal(validate(options), undefined);
    assert.deepEqual(options, before);
    assert.deepEqual(h.credentials, [], "audit inspects configuration without credential discovery or requests");
    if (provider === "github-copilot") {
      const snapshot = h.adapter.current();
      assert.equal(snapshot.profiles.get(h.route).api, "openai-responses");
      assert.deepEqual(snapshot.models.getModels(h.route).map((model) => model.id), ["budget-test-model"]);
    }
  });

  test(`${provider}: audit requires the exact native class, not names, duck types, or subclasses`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const Native = provider === "deepseek" ? DeepSeek.DeepSeekAdapter : PiAi.PiAiAdapter;
    class Derived extends Native {}
    const candidates = [
      { constructor: Native, stream: () => [] },
      new Derived(h.adapter.config),
      { stream: h.adapter.stream.bind(h.adapter), config: h.adapter.config },
    ];
    for (const adapter of candidates) {
      const llm = { adapters: new Map([[h.route, { adapter }]]) };
      await assert.rejects(auditBudgetProvider(llm, budget), uncertain);
    }
  });

  test(`${provider}: validator pins the Map, registration, adapter, and request route`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const validate = await auditBudgetProvider(h.llm, budget);
    const registrations = h.llm.adapters;
    const options = optionsFor(provider);
    const mutations = [
      () => { h.llm.adapters = new Map(registrations); },
      () => { registrations.set("unreviewed", { adapter: h.adapter }); },
      () => { registrations.clear(); },
      () => { registrations.set(h.route, { ...h.registration }); },
      () => { h.registration.adapter = {}; },
    ];
    for (const mutate of mutations) {
      try {
        mutate();
        assert.throws(() => validate(options), uncertain);
      } finally {
        h.llm.adapters = registrations;
        registrations.clear();
        h.registration.adapter = h.adapter;
        registrations.set(h.route, h.registration);
      }
      assert.doesNotThrow(() => validate(options));
    }
    for (const route of [undefined, "unreviewed", provider === "deepseek" ? "github-copilot" : "deepseek-official"]) {
      assert.throws(() => validate({ ...options, provider: route }), uncertain);
    }
  });

  test(`${provider}: validator rejects changed connection snapshots after admission`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const validate = await auditBudgetProvider(h.llm, budget);
    if (provider === "deepseek") {
      const connection = h.adapter.config.options();
      t.mock.method(h.adapter.config, "options", () => ({ ...connection, maxTokens: 9999 }));
    } else {
      const profiles = h.adapter.current().profiles;
      const changed = new Map(profiles);
      changed.set(h.route, { ...profiles.get(h.route), transport: "websocket" });
      t.mock.method(h.adapter.config, "profiles", () => changed);
    }
    assert.throws(() => validate(optionsFor(provider)), uncertain);
  });

  test(`${provider}: text/tool history is admitted but media is refused recursively before dispatch`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const validate = await auditBudgetProvider(h.llm, budget);
    const withContent = (content) => optionsFor(provider, { messages: [{ role: "user", content }] });
    assert.doesNotThrow(() => validate(withContent([
      { type: "text", text: JSON.stringify({ operationalBudget: false, budgetMaxTokens: 9999 }) },
      { type: "reasoning", text: "reason" },
      { type: "tool-call", id: "call-1", name: "host_tool", arguments: "{}" },
      { type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "result" }] },
    ])));
    for (const type of ["image", "file", "audio", "video", "unknown"]) {
      const block = { type };
      assert.throws(() => validate(withContent([block])), uncertain, type);
      assert.throws(() => validate(withContent([{
        type: "tool-result", content: [{ type: "tool-result", content: [block] }],
      }])), uncertain, `nested ${type}`);
    }
    for (const content of [undefined, null, "not blocks", {}]) {
      assert.throws(() => validate(withContent([{ type: "tool-result", content }])), uncertain);
    }
  });
}

test("audit refuses missing/ambiguous internal registrations and unsupported routes", limits, async (t) => {
  const h = await runtimeFor(t, "deepseek");
  for (const adapters of [
    undefined, {}, [], new Map(),
    new Map([["unreviewed", h.registration]]),
    new Map([[h.route, h.registration], ["github-copilot", h.registration]]),
  ]) await assert.rejects(auditBudgetProvider({ adapters }, budget), uncertain);
});

const require = createRequire(import.meta.url);
const piEntry = import.meta.resolve("@earendil-works/pi-ai");
const sdkRequire = createRequire(piEntry);
const pinnedVersions = [
  ["@deepseek-ai/dsh-llm", require.resolve("@deepseek-ai/dsh-llm/package.json"), "0.1.2-alpha.2", "deepseek"],
  ["@deepseek-ai/dsh-llm-deepseek", require.resolve("@deepseek-ai/dsh-llm-deepseek/package.json"), "0.1.2-alpha.2", "deepseek"],
  ["@deepseek-ai/dsh-llm-pi-ai", require.resolve("@deepseek-ai/dsh-llm-pi-ai/package.json"), "0.1.2-alpha.2", "github-copilot"],
  ["@earendil-works/pi-ai", fileURLToPath(new URL("../package.json", piEntry)), "0.84.4", "github-copilot"],
  ["openai", join(dirname(sdkRequire.resolve("openai")), "package.json"), "6.40.0", "github-copilot"],
];

test("installed runtime, adapters, pi-ai, and its OpenAI SDK match the audited pins", () => {
  for (const [name, path, expected] of pinnedVersions) {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, expected, name);
  }
});

for (const [name, path, expected, provider] of pinnedVersions) {
  test(`audit rejects version drift in ${name}`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const manifest = require(path);
    const original = manifest.version;
    assert.equal(original, expected);
    // Mutate only the in-memory require cache, never an installed package file.
    try {
      manifest.version = "0.0.0-unaudited";
      await assert.rejects(auditBudgetProvider(h.llm, budget), uncertain, name);
    } finally {
      manifest.version = original;
    }
  });
}

for (const [label, change] of [
  ["different endpoint", (config) => { config.baseURL = "https://untrusted.invalid/v1"; }],
  ["implicit endpoint", (config) => { delete config.baseURL; }],
  ["different credential", (config) => { config.apiKeyEnv = "UNTRUSTED_KEY"; }],
  ["default credential", (config) => { delete config.apiKeyEnv; }],
]) {
  test(`DeepSeek audit refuses ${label}`, limits, async (t) => {
    const h = await runtimeFor(t, "deepseek", change);
    await assert.rejects(auditBudgetProvider(h.llm, budget), uncertain);
  });
}

for (const [label, change] of [
  ["implicit catalog API", (profile) => { delete profile.api; profile.models[0].id = "gpt-4.1"; }],
  ["different API", (profile) => { profile.api = "openai-completions"; }],
  ["implicit endpoint", (profile) => { delete profile.baseURL; }],
  ["different endpoint", (profile) => { profile.baseURL = "https://untrusted.invalid/v1"; }],
  ["credential discovery", (profile) => { delete profile.apiKeyEnv; }],
  ["different credential", (profile) => { profile.apiKeyEnv = "UNTRUSTED_KEY"; }],
  ["WebSocket transport", (profile) => { profile.transport = "websocket"; }],
  ["automatic nonfetch transport", (profile) => { profile.transport = "auto"; }],
  ["implicit model catalog", (profile) => { delete profile.models; }],
  ["media model", (profile) => { profile.models[0].input = ["text", "image"]; }],
]) {
  test(`PiAi audit refuses ${label}`, limits, async (t) => {
    const h = await runtimeFor(t, "github-copilot", (config) => change(config.providers["github-copilot"]));
    await assert.rejects(auditBudgetProvider(h.llm, budget),
      (error) => error.code === "DSH_BUDGET_UNCERTAIN" || error instanceof TypeError && /budgetBaseUrl/.test(error.message));
  });
}

test("PiAi audit checks resolved model API/endpoint, not just the provider profile", limits, async (t) => {
  const h = await runtimeFor(t, "github-copilot");
  const snapshot = h.adapter.current();
  const models = snapshot.models.getModels(h.route);
  for (const override of [
    { api: "openai-completions" }, { baseUrl: "https://untrusted.invalid/v1" }, { input: ["image"] },
  ]) {
    const mock = t.mock.method(snapshot.models, "getModels", () => models.map((model) => ({ ...model, ...override })));
    try {
      await assert.rejects(auditBudgetProvider(h.llm, budget), uncertain);
    } finally {
      mock.mock.restore();
    }
  }
  const mock = t.mock.method(snapshot.models, "getModels", () => []);
  try {
    await assert.rejects(auditBudgetProvider(h.llm, budget), uncertain);
  } finally {
    mock.mock.restore();
  }
});

for (const provider of providers) {
  test(`${provider}: six-argument worker audits on ready and fences changed registrations in middleware`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const w = workerFor(t, h.llm, provider, budget);
    assert.notEqual(globalThis.fetch, w.noNetwork, "the sixth constructor argument installs the guard");
    await w.worker.ready();
    assert.equal(w.loader.calls, 1);
    assert.deepEqual(w.events(), [{
      jsonrpc: "2.0", method: "event",
      params: { type: "ready", version: 1, dshVersion: "0.1.2-alpha.2" },
    }]);
    h.llm.adapters.set("unreviewed", { adapter: h.adapter });
    let dispatched = false;
    assert.throws(() => w.stream(w.options, () => { dispatched = true; return []; }), uncertain);
    assert.equal(dispatched, false);
    assert.throws(() => w.worker.assertHealthy(), uncertain);
  });

  test(`${provider}: worker stream requires ready's provider audit even with valid run ownership`, limits, async (t) => {
    const h = await runtimeFor(t, provider);
    const w = workerFor(t, h.llm, provider, budget);
    let dispatched = false;
    assert.throws(() => w.stream(w.options, () => { dispatched = true; return []; }), /provider audit is not ready/);
    assert.equal(dispatched, false);
    assert.deepEqual(w.events(), []);
    await assert.rejects(w.worker.ready(), /provider audit is not ready/);
  });

  for (const maxTokens of [undefined, 4096, 8]) {
    test(`${provider}: worker guard retains trusted cap with model maxTokens=${maxTokens} and preserves parent failure`, limits, async (t) => {
      const h = await runtimeFor(t, provider);
      const w = workerFor(t, h.llm, provider, budget);
      await w.worker.ready();
      const parentError = Object.assign(new Error("DSH_BUDGET_EXCEEDED: parent denied reservation"), {
        code: "DSH_BUDGET_EXCEEDED", data: { remaining: 0 },
      });
      const calls = [];
      t.mock.method(w.worker.peer, "request", async (method, params) => {
        calls.push({ method, params });
        throw parentError;
      });
      const options = {
        ...w.options, ...(maxTokens === undefined ? {} : { maxTokens }),
        operationalBudget: false, budgetBaseUrl: "https://untrusted.invalid", budgetMaxTokens: 9999,
      };
      const body = {
        model: options.model, stream: true,
        [provider === "deepseek" ? "max_tokens" : "max_output_tokens"]: 4096,
      };
      const next = async function* () {
        try {
          await fetch(`${baseUrl}${provider === "deepseek" ? "/chat/completions" : "/responses"}`, {
            method: "POST", body: JSON.stringify(body),
          });
        } catch (error) {
          throw new LlmError("provider wrapper must not hide the budget failure", "NETWORK", { cause: error });
        }
        assert.fail("a denied reservation cannot yield provider output");
      };
      await assert.rejects(collect(w.stream(options, next)), (error) => {
        assert.equal(error, parentError);
        assert.equal(error instanceof LlmError, false);
        return true;
      });
      assert.deepEqual(calls, [{
        method: "budget.reserve", params: { maxTokens: maxTokens === 8 ? 8 : budget.budgetMaxTokens },
      }]);
      assert.throws(() => w.worker.assertHealthy(), (error) => error === parentError);
      assert.equal(w.worker.creation.signal.reason, parentError);
      assert.ok(w.cancellations.some((reason) => reason.kind === "hook"));
      w.worker.fail(new Error("later provider error"));
      assert.throws(() => w.worker.assertHealthy(), (error) => error === parentError);
      let retried = false;
      assert.throws(() => w.stream(options, () => { retried = true; return []; }), (error) => error === parentError);
      assert.equal(retried, false);
    });
  }
}

test("worker ready refuses unaudited providers before emitting ready", limits, async (t) => {
  const w = workerFor(t, { adapters: new Map() }, "deepseek", budget);
  await assert.rejects(w.worker.ready(), uncertain);
  assert.deepEqual(w.events(), []);
  assert.equal(w.worker.initialized, false);
});

test("legacy worker does not audit/install a budget and model arguments cannot turn it on", limits, async (t) => {
  const w = workerFor(t, {}, "deepseek", parseBridgeConfig({}));
  assert.equal(globalThis.fetch, w.noNetwork);
  await w.worker.ready();
  assert.equal(w.events()[0].params.type, "ready");
  const chunk = { type: "text-delta", index: 0, text: "legacy" };
  const options = { ...w.options, ...budget, maxTokens: 4096 };
  assert.deepEqual(await collect(w.stream(options, async function* () { yield chunk; })), [chunk]);
  assert.equal(globalThis.fetch, w.noNetwork);
  assert.doesNotThrow(() => w.worker.assertHealthy());
});
