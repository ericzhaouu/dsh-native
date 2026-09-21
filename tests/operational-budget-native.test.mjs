import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import ts from "typescript";
import { validateRuntimeBudgetProof } from "../scripts/lib/gateway-acceptance-adapter.mjs";

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
let createNativeHarness, createIsolatedCompletion, resolveNativeRoute, parseDshConfig, resolveOperationalBudget;
try {
  ({ createNativeHarness } = await import("../dist/native/harness.js"));
  ({ createIsolatedCompletion } = await import("../dist/native/isolated.js"));
  ({ resolveNativeRoute } = await import("../dist/native/route.js"));
  ({ parseDshConfig, resolveOperationalBudget } = await import("../dist/config.js"));
} finally {
  hooks.deregister();
}

// Keep the genuine installed host runner away from operator config and log files.
const stateDir = resolve("artifacts", `operational-budget-native-${process.pid}`);
const environment = {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: join(stateDir, "absent-config.json"),
  OPENCLAW_LOG_LEVEL: "silent",
};
const previousEnv = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const loadHost = (file) => import(new URL(`../node_modules/openclaw/dist/${file}`, import.meta.url));
const { setLoggerOverride } = await loadHost("logging-CoIcMOSn.js");
setLoggerOverride({ level: "silent", consoleLevel: "silent", file: join(stateDir, "host.log") });
after(() => setLoggerOverride(null));
const { t: runWithModelFallback } = await loadHost("model-fallback-runner-DfBb8xXp.js");
const { t: InstalledPreflightError, i: isPreflightError, s: preflightOwner } = await loadHost("errors-70ml6R0Z.js");
const { AgentHarnessPreflightError } = await import("openclaw/plugin-sdk/agent-harness-runtime");
const { f: projectAttemptTerminal } = await loadHost("agent-run-terminal-outcome-CigeY75d.js");

const limits = { concurrency: false, timeout: 15_000 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cap = (overrides = {}) => ({
  maxModelRequests: 8, maxInputTokens: 200_000, maxOutputTokens: 800,
  maxToolCalls: 6, maxDurationMs: 60_000, ...overrides,
});
const globalCap = cap({ maxModelRequests: 4, maxOutputTokens: 500 });
const agentCap = cap({ maxInputTokens: 100_000, maxToolCalls: 2, maxDurationMs: 30_000 });
const reviewerCap = cap({ maxModelRequests: 1 });
const effectiveCap = cap({
  maxModelRequests: 4, maxInputTokens: 100_000, maxOutputTokens: 500,
  maxToolCalls: 2, maxDurationMs: 30_000,
});
const measured = { input: 12, output: 3, cacheRead: 2, cacheWrite: 0 };
const success = (input) => ({
  text: "budget-aware answer", sessionId: input.sessionId, usage: { ...measured }, stopReason: "stop", toolCalls: 0,
});
const budgetMessages = {
  DSH_BUDGET_EXCEEDED: "DSH operator-defined operational budget prevents further work.",
  DSH_BUDGET_UNCERTAIN: "DSH operational budget has unresolved work; inspect retained evidence before any new attempt.",
};
const model = () => ({
  id: "deepseek-v4-pro", name: "fixture", provider: "deepseek", api: "openai-completions",
  baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 128,
});
const configuration = (extra = {}) => parseDshConfig({
  stateDir, startupTimeoutMs: 1000, shutdownTimeoutMs: 1000, streamIdleTimeoutMs: 1000, ...extra,
});
const memoryParams = {
  trigger: "memory", memoryFlushWritePath: "memory\\fixture.md", transcriptPrompt: "", silentExpected: true,
};

function fixture(t, settings = {}, overrides = {}) {
  const calls = { run: [], recover: [], compact: [], tool: [], resolve: [], persisted: [] };
  const config = configuration(settings);
  const p = {
    sessionId: "canonical-session", sessionKey: "agent:worker:budget", agentId: "worker", runId: "host-run",
    sessionFile: "sqlite:budget-fixture", workspaceDir: process.cwd(), prompt: "prepared request", timeoutMs: 5000,
    agentHarnessId: "dsh-native", agentHarnessRuntimeOverride: "dsh-native",
    provider: "deepseek", modelId: "deepseek-v4-pro", model: model(), resolvedApiKey: "fixture-not-a-real-key",
    thinkLevel: "off", config: {},
    hostCapabilities: { kind: "agent-harness-host-capability", version: 1, assertActive() {} },
    ...overrides,
  };
  const context = [{ role: "user", content: "existing canonical evidence", timestamp: 1 }];
  const sdk = {
    getModelProviderRequestTransport: () => undefined,
    resolveSessionAgentIds(input) { calls.resolve.push(input); return { sessionAgentId: "worker" }; },
    setActiveEmbeddedRun() {}, clearActiveEmbeddedRun() {}, emitAgentEvent() {},
    runAgentHarnessLlmInputHook() {}, runAgentHarnessLlmOutputHook() {},
    async runAgentHarnessBeforeAgentFinalizeHook() { return { action: "continue" }; },
    async awaitAgentHarnessAgentEndHook() {},
  };
  const host = {
    systemPrompt: "host-owned system instructions", prompt: p.prompt,
    tools: [{ name: "read", description: "read fixture", parameters: { type: "object" } }],
    async executeTool(call) { calls.tool.push(call); return { text: "read result", isError: false }; },
    getReplayState: () => ({ hadPotentialSideEffects: false, replaySafe: true }),
    getToolCounts: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
    async dispose() {},
  };
  const transcript = {
    nativeStateId: "canonical-state", messages: context, contextMessages: context,
    async persistUser() {}, markSentToProvider() {},
    async persistAssistant(message) {
      calls.persisted.push(message);
      return { owned: true, message, idempotencyKey: "dsh-native:host-run:assistant" };
    },
  };
  const runtime = {
    async run(input) { calls.run.push(input); return success(input); },
    async recoverCompaction(input) { calls.recover.push(input); },
    async compact(input) {
      calls.compact.push(input);
      return { compacted: true, sessionId: input.sessionId, summary: "checkpoint", tokensBefore: 100, tokensAfter: 10 };
    },
    async dispose() {},
  };
  const harness = createNativeHarness(config, runtime, {
    loadSdk: async () => sdk, prepareHost: async () => host, prepareTranscript: async () => transcript,
    assertSourceReplySettled: async () => {},
    readMaintenanceContext: async () => ({
      nativeStateId: "canonical-state", messages: context, contextMessages: context, async assertCurrent() {},
    }),
  });
  t.after(() => harness.dispose());
  return { calls, config, p, sdk, host, runtime, harness };
}

async function enter(f, entry) {
  if (entry === "compact") return f.harness.compact({ ...f.p, runtimeModel: f.p.model, model: f.p.model.id });
  return f.harness.runAttempt({ ...f.p, ...(entry === "memory" ? memoryParams : {}) });
}
function assertSuccess(result, entry) {
  if (entry === "compact") assert.equal(result.ok, true, result.reason);
  else assert.equal(result.terminal.kind, "ok", result.terminal.error?.stack);
}
function assertBudgetError(error, original) {
  assert.equal(AgentHarnessPreflightError, InstalledPreflightError);
  assert.equal(Object.getPrototypeOf(error), AgentHarnessPreflightError.prototype);
  assert.equal(isPreflightError(error), true);
  assert.equal(preflightOwner(error), undefined);
  assert.equal(error.scope, undefined, "harness-scoped errors permit an ownership-changing fallback");
  assert.equal(error.name, "AgentHarnessPreflightError");
  assert.equal(error.code, original.code);
  assert.equal(error.cause, original);
  assert.notEqual(error, original);
  assert.equal(error.message, budgetMessages[original.code]);
  assert.equal(error.status, undefined);
  return true;
}
function fallback(run, options = {}) {
  return runWithModelFallback({
    cfg: {
      plugins: { enabled: false },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
      models: { providers: {
        deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com",
          models: [model(), { ...model(), id: "deepseek-v4-flash" }] },
      } },
    },
    agentId: "worker", provider: "deepseek", model: "deepseek-v4-pro",
    fallbacksOverride: ["deepseek/deepseek-v4-flash"], skipAuthProfileRuntime: true, manifestPlugins: [],
    run, ...options,
  });
}

test("native source graph includes config, isolated and the new budget terminal boundary", () => {
  for (const name of ["native/harness", "native/isolated", "native/route", "native/host", "native/memory",
    "native/transcript", "native/source-reply-ownership", "config", "protocol", "bridge/budget-terminal"]) {
    assert.ok(loaded.has(new URL(`${name}.ts`, srcRoot).href), `${name} must come from source, not stale dist`);
  }
});

for (const entry of ["foreground", "memory", "compact"]) {
  for (const [name, settings] of [
    ["uncapped", {}],
    ["global", { operationalBudget: globalCap }],
    ["per-agent", { operationalBudgetByAgent: { worker: agentCap, reviewer: reviewerCap } }],
    ["both", { operationalBudget: globalCap, operationalBudgetByAgent: { worker: agentCap, reviewer: reviewerCap } }],
  ]) {
    for (const agentId of ["worker", "reviewer", undefined]) {
      test(`${entry}: ${name} config, ${agentId ?? "omitted"} identity reaches every runtime entry`, limits, async (t) => {
        const f = fixture(t, settings, { agentId });
        assertSuccess(await enter(f, entry), entry);
        const inputs = entry === "compact" ? f.calls.compact : [...f.calls.recover, ...f.calls.run];
        assert.equal(inputs.length, entry === "foreground" ? 2 : 1);
        const resolveAgent = agentId === undefined && settings.operationalBudgetByAgent !== undefined;
        const expectedAgent = resolveAgent ? "worker" : agentId;
        const selected = settings.operationalBudgetByAgent?.[expectedAgent];
        const expectedBudget = !selected ? settings.operationalBudget : !settings.operationalBudget ? selected
          : expectedAgent === "worker" ? effectiveCap : { ...globalCap, maxModelRequests: 1 };
        for (const input of inputs) {
          assert.equal(Object.hasOwn(input, "agentId"), true);
          assert.equal(input.agentId, expectedAgent);
          assert.equal(input.sessionId, f.p.sessionId);
          assert.equal(input.runId, f.p.runId);
          assert.equal(input.nativeStateId, entry === "memory" ? "canonical-state\0memory\0host-run" : "canonical-state");
          assert.equal(Object.hasOwn(input, "operationalBudget"), false, "only the runtime reads trusted native config");
          assert.deepEqual(resolveOperationalBudget(f.config, input.agentId), expectedBudget);
        }
        assert.equal(f.calls.resolve.length, resolveAgent ? 1 : 0);
        if (resolveAgent) assert.deepEqual(f.calls.resolve[0], { config: f.p.config, sessionKey: f.p.sessionKey });
        if (entry === "memory") {
          assert.equal(f.calls.recover.length, 0);
          assert.equal(f.calls.persisted.length, 0);
        }
      });
    }
  }

  test(`${entry}: untrusted p/model/prompt/tool operationalBudget data never becomes a runtime cap`, limits, async (t) => {
    const f = fixture(t, { operationalBudget: globalCap, operationalBudgetByAgent: { worker: agentCap } });
    let reads = 0;
    f.p.operationalBudget = cap({ maxModelRequests: 999 });
    f.p.model.operationalBudget = cap({ maxToolCalls: 999 });
    Object.defineProperty(f.p.model, "operationalBudgetByAgent", {
      enumerable: true, get() { reads++; throw new Error("untrusted budget accessor was read"); },
    });
    f.p.config.operationalBudget = cap({ maxModelRequests: 999 });
    f.host.prompt = JSON.stringify({ operationalBudget: cap({ maxToolCalls: 999 }), agentId: "attacker" });
    const call = { name: "read", callId: "untrusted", arguments: {
      operationalBudget: cap({ maxToolCalls: 999 }), agentId: "attacker", path: "fixture",
    } };
    const run = f.runtime.run;
    f.runtime.run = async (input) => {
      await input.executeTool(call, input.signal);
      return run(input);
    };
    assertSuccess(await enter(f, entry), entry);
    assert.equal(reads, 0);
    if (entry !== "compact") assert.deepEqual(f.calls.tool, [call], "tool arguments remain data, not control");
    for (const input of [...f.calls.run, ...f.calls.recover, ...f.calls.compact]) {
      assert.equal(input.agentId, "worker");
      assert.equal(Object.hasOwn(input, "operationalBudget"), false);
      assert.deepEqual(resolveOperationalBudget(f.config, input.agentId), effectiveCap);
    }
  });
}

for (const code of Object.keys(budgetMessages)) {
  for (const entry of ["foreground", "memory", "recover"]) {
    for (const propagation of ["throw", "classified-result"]) {
      test(`${code} from ${entry}: genuine host ${propagation} never tries a fallback model`, limits, async (t) => {
        const f = fixture(t, { operationalBudget: globalCap });
        const original = Object.assign(new Error("429 rate limit exceeded; provider request timed out; insufficient quota"), {
          code, status: 429, cause: new Error("upstream details"),
        });
        const stage = entry === "recover" ? "recoverCompaction" : "run";
        let runtimeCalls = 0, terminalError;
        f.runtime[stage] = async () => { runtimeCalls++; throw original; };
        const cleanupError = new Error("secondary cleanup failure");
        f.host.dispose = async () => { throw cleanupError; };
        f.sdk.clearActiveEmbeddedRun = () => { throw cleanupError; };
        f.sdk.awaitAgentHarnessAgentEndHook = async () => { throw cleanupError; };
        const attempts = [], onError = t.mock.fn(), canFallbackAfterError = t.mock.fn(() => true);
        await assert.rejects(fallback(async (provider, modelId) => {
          attempts.push(`${provider}/${modelId}`);
          const result = await enter(f, entry);
          assert.equal(result.terminal.kind, "failed");
          assert.equal(result.terminal.source, entry === "recover" ? "precheck" : "prompt");
          assert.deepEqual(result.assistantTexts, []);
          assert.equal(result.currentAttemptCompletedAssistant, undefined);
          assert.equal(result.assistantTranscriptOwned, undefined);
          const projection = projectAttemptTerminal(result.terminal);
          assert.equal(projection.failed, true);
          terminalError = projection.promptError;
          assert.equal(terminalError, result.terminal.error);
          assertBudgetError(terminalError, original);
          if (propagation === "throw") throw terminalError;
          return result;
        }, {
          onError, canFallbackAfterError,
          ...(propagation === "classified-result" ? {
            classifyResult: ({ result }) => ({ error: projectAttemptTerminal(result.terminal).promptError }),
          } : {}),
        }), (error) => {
          assert.equal(error, terminalError, "fallback must preserve the exact wrapper, not its provider-like cause");
          return assertBudgetError(error, original);
        });
        assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro"]);
        assert.equal(runtimeCalls, 1);
        assert.equal(onError.mock.callCount(), 0);
        assert.equal(canFallbackAfterError.mock.callCount(), 0, "SDK preflight check must short-circuit provider classification");
        assert.equal(f.calls.persisted.length, 0);
      });
    }
  }

  test(`${code}: explicit compaction returns a stable budget diagnostic, not a provider message`, limits, async (t) => {
    const f = fixture(t);
    let calls = 0;
    f.runtime.compact = async () => {
      calls++;
      throw Object.assign(new Error("provider timeout; rate limit"), { code, status: 429 });
    };
    assert.deepEqual(await enter(f, "compact"), {
      ok: false, compacted: false, compactionKind: "native-harness",
      reason: budgetMessages[code], failure: { reason: budgetMessages[code] },
    });
    assert.equal(calls, 1);
  });
}

for (const [label, error, reason] of [
  ["rate limit", Object.assign(new Error("rate limit exceeded"), { status: 429 }), "rate_limit"],
  ["timeout", Object.assign(new Error("provider request timed out"), { code: "ETIMEDOUT" }), "timeout"],
  ["uncoded budget-like text", new Error("DSH_BUDGET_EXCEEDED: rate limit exceeded"), "rate_limit"],
]) {
  test(`control: ${label} retains its native identity and genuine provider fallback behavior`, limits, async (t) => {
    const f = fixture(t);
    f.runtime.run = async () => { throw error; };
    const attempts = [];
    const result = await fallback(async (_provider, modelId) => {
      attempts.push(modelId);
      if (attempts.length > 1) return "recovered";
      const failed = await f.harness.runAttempt(f.p);
      assert.equal(failed.terminal.error, error);
      assert.equal(isPreflightError(error), false);
      throw failed.terminal.error;
    });
    assert.deepEqual(attempts, ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.equal(result.outcome, "completed");
    assert.equal(result.result, "recovered");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].reason, reason);
  });
}

function isolatedParams(overrides = {}) {
  const prepared = model();
  return {
    provider: prepared.provider, modelId: prepared.id, model: prepared, agentId: "worker",
    authorization: { owner: "host", model: prepared, auth: { apiKey: "fixture-not-a-real-key", source: "profile", mode: "api-key" } },
    config: {}, workspaceDir: process.cwd(), systemPrompt: "host system", prompt: "isolated request",
    timeoutMs: 5000, outputTextPolicy: "strict-visible", assertCurrent() {}, ...overrides,
  };
}

function knownProof(input, uncertain = false) {
  const runtimeConfig = {
    version: 1, runId: input.runId, sessionKey: input.sessionId, agentId: input.agentId,
    operationalBudget: structuredClone(input.operationalBudget), contextWindow: input.contextWindow, maxTokens: input.maxTokens,
  };
  const entries = [
    { type: "admitted" },
    { type: "request_reserved", requestId: "request-1", purpose: "main", inputTokens: input.contextWindow, outputTokens: input.maxTokens },
    ...(uncertain ? [{ type: "fenced" }] : [
      { type: "request_settled", requestId: "request-1", usage: measured },
      { type: "settled", providerSettled: true, toolsSettled: true },
    ]),
  ].map((event, index) => ({ ...event, seq: index, at: 1000 + index }));
  const ledger = {
    version: 1, runId: input.runId, sessionKey: input.sessionId, agentId: input.agentId,
    configSha256: hash(JSON.stringify(runtimeConfig)), entries,
  };
  validateRuntimeBudgetProof({ runtimeConfig, ledger }, {
    runId: input.runId, sessionKey: input.sessionId, agentId: input.agentId, ...(uncertain ? {} : { settled: true }),
  });
  return { runtimeConfig, ledger };
}

function isolatedFixture(t, settings = {}) {
  // In-memory filesystem, not real temporary directories or disposable dist builds.
  const files = new Map(), removed = [], inputs = [], configs = [], events = [];
  let sequence = 0, runError, disposeError;
  const original = Object.fromEntries(["mkdir", "mkdtemp", "rm"].map((key) => [key, fs[key]]));
  t.mock.method(fs, "mkdir", async (path) => { assert.equal(path, stateDir); });
  t.mock.method(fs, "mkdtemp", async (prefix) => {
    assert.equal(prefix, join(stateDir, "isolated-"));
    return `${prefix}fixture-${++sequence}`;
  });
  t.mock.method(fs, "rm", async (path, options) => {
    assert.ok(configs.some((config) => config.stateDir === path));
    assert.deepEqual(options, { recursive: true, force: true });
    removed.push(path);
    events.push("remove");
    for (const key of files.keys()) if (key.startsWith(`${path}${sep}`)) files.delete(key);
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const key of Object.keys(original)) fs[key] = original[key];
    syncBuiltinESMExports();
  });
  const service = createIsolatedCompletion(configuration(settings),
    (p, config) => resolveNativeRoute({ ...p, thinkLevel: "off" }, config, () => undefined), {
      now: () => 1234,
      runtimeFactory(config) {
        configs.push(config);
        return {
          async run(input) {
            inputs.push(input);
            const directory = join(config.stateDir, hash(input.nativeStateId));
            files.set(join(directory, "binding.json"), JSON.stringify({ status: runError ? "blocked" : "ready" }));
            if (input.operationalBudget) {
              const { runtimeConfig, ledger } = knownProof(input, runError?.code === "DSH_BUDGET_UNCERTAIN");
              for (const base of [directory, join(directory, "budgets", hash(input.runId))]) {
                files.set(join(base, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
                files.set(join(base, "operational-budget-ledger.json"), JSON.stringify(ledger));
              }
            }
            if (runError) throw runError;
            return success(input);
          },
          async dispose() { events.push("dispose"); if (disposeError) throw disposeError; },
        };
      },
    });
  t.after(() => service.dispose());
  return { service, files, removed, inputs, configs, events, fail(error) { runError = error; },
    failDispose(error) { disposeError = error; } };
}

for (const [name, settings, expected] of [
  ["global", { operationalBudget: globalCap }, globalCap],
  ["exact agent", { operationalBudgetByAgent: { worker: agentCap } }, agentCap],
  ["global/agent minimum", { operationalBudget: globalCap, operationalBudgetByAgent: { worker: agentCap } }, effectiveCap],
]) {
  test(`isolated ${name}: wire trusted caps and retain exact current and historical receipt files after success/dispose`, limits, async (t) => {
    const f = isolatedFixture(t, settings);
    const p = isolatedParams({ operationalBudget: cap({ maxModelRequests: 1 }) });
    p.authorization.model.operationalBudget = cap({ maxToolCalls: 999, maxOutputTokens: 1 });
    const result = await f.service.run(p);
    assert.equal(f.inputs.length, 1);
    const input = f.inputs[0];
    assert.equal(input.agentId, "worker");
    assert.deepEqual(input.operationalBudget, expected);
    assert.notEqual(input.operationalBudget, expected);
    assert.deepEqual(input.tools, []);
    assert.equal(Object.hasOwn(input, "taskPreparation"), false);
    assert.match(input.runId, /^isolated-run-/);
    assert.match(input.sessionId, /^isolated-/);
    assert.match(input.nativeStateId, /^isolated-state-/);
    assert.deepEqual(result.budgetReceipt, {
      directory: join(f.configs[0].stateDir, hash(input.nativeStateId)),
      runId: input.runId, sessionKey: input.sessionId, agentId: "worker",
    });
    const before = new Map(f.files);
    assert.equal(before.size, 5);
    const directory = result.budgetReceipt.directory;
    for (const file of ["operational-budget-config.json", "operational-budget-ledger.json"]) {
      assert.equal(f.files.get(join(directory, file)), f.files.get(join(directory, "budgets", hash(input.runId), file)));
    }
    const proof = {
      runtimeConfig: JSON.parse(f.files.get(join(directory, "operational-budget-config.json"))),
      ledger: JSON.parse(f.files.get(join(directory, "operational-budget-ledger.json"))),
    };
    const accounting = validateRuntimeBudgetProof(proof, { ...result.budgetReceipt, settled: true });
    assert.equal(accounting.status, "settled");
    assert.equal(accounting.quiescent, true);
    assert.deepEqual(result.assistant.content, [{ type: "text", text: "budget-aware answer" }]);
    assert.equal(result.assistant.usage.totalTokens, 17);
    assert.equal(result.assistant.timestamp, 1234);
    await f.service.dispose();
    assert.deepEqual(f.files, before, "neither successful completion nor service disposal may remove receipt evidence");
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.events, ["dispose"]);
  });
}

test("isolated sequential agents retain disjoint receipt identities and immutable earlier evidence", limits, async (t) => {
  const f = isolatedFixture(t, { operationalBudgetByAgent: { worker: agentCap, reviewer: reviewerCap } });
  const first = await f.service.run(isolatedParams());
  const firstFiles = new Map(f.files);
  const second = await f.service.run(isolatedParams({ agentId: "reviewer" }));
  for (const key of ["directory", "runId", "sessionKey", "agentId"]) {
    assert.notEqual(first.budgetReceipt[key], second.budgetReceipt[key], key);
  }
  assert.deepEqual(f.inputs.map((input) => input.agentId), ["worker", "reviewer"]);
  assert.deepEqual(f.inputs.map((input) => input.operationalBudget), [agentCap, reviewerCap]);
  assert.equal(second.budgetReceipt.directory, join(f.configs[1].stateDir, hash(f.inputs[1].nativeStateId)));
  await f.service.dispose();
  for (const [path, contents] of firstFiles) assert.equal(f.files.get(path), contents);
  assert.equal(f.files.size, 10);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.events, ["dispose", "dispose"]);
});

for (const [name, settings] of [
  ["no caps", {}],
  ["unmatched agent", { operationalBudgetByAgent: { other: agentCap } }],
]) {
  test(`isolated ${name}: legacy successful cleanup remains disposable and untrusted caps cannot opt in`, limits, async (t) => {
    const f = isolatedFixture(t, settings);
    const p = isolatedParams({ operationalBudget: cap() });
    p.authorization.model.operationalBudget = cap();
    const result = await f.service.run(p);
    assert.equal(f.inputs[0].agentId, "worker");
    assert.equal(Object.hasOwn(f.inputs[0], "operationalBudget"), false);
    assert.equal(Object.hasOwn(result, "budgetReceipt"), false);
    assert.equal(f.inputs[0].maxTokens, 128);
    assert.deepEqual(f.removed, [f.configs[0].stateDir]);
    assert.equal(f.files.size, 0);
    assert.deepEqual(f.events, ["dispose", "remove"]);
    await f.service.dispose();
    assert.equal(f.removed.length, 1);
  });
}

for (const code of Object.keys(budgetMessages)) {
  test(`isolated ${code}: exact SDK identity stops real model fallback and never cleans failed state`, limits, async (t) => {
    const f = isolatedFixture(t, { operationalBudget: globalCap });
    const original = Object.assign(new Error("provider request timed out; 429 rate limit exceeded"), { code, status: 429 });
    f.fail(original);
    const attempts = [];
    await assert.rejects(fallback(async (provider, modelId) => {
      attempts.push(`${provider}/${modelId}`);
      return f.service.run(isolatedParams());
    }), (error) => assertBudgetError(error, original));
    assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro"]);
    assert.equal(f.inputs.length, 1);
    const before = new Map(f.files);
    await f.service.dispose();
    assert.deepEqual(f.files, before);
    assert.equal(f.files.size, 5);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.events, ["dispose"]);
  });
}

for (const scenario of ["run-and-dispose-uncertain", "cleanup-only-uncertain", "secondary-generic-cleanup"]) {
  test(`isolated ${scenario}: cleanup cannot restore provider fallback`, limits, async (t) => {
    const f = isolatedFixture(t, { operationalBudget: globalCap });
    const primary = Object.assign(new Error("429 provider timeout"), { code: "DSH_BUDGET_UNCERTAIN" });
    const cleanup = scenario === "secondary-generic-cleanup" ? new Error("503 cleanup failed")
      : Object.assign(new Error("unresolved prior operations"), { code: "DSH_BUDGET_UNCERTAIN" });
    if (scenario !== "cleanup-only-uncertain") f.fail(primary);
    f.failDispose(cleanup);
    const attempts = [];
    await assert.rejects(fallback(async (provider, modelId) => {
      attempts.push(`${provider}/${modelId}`);
      return f.service.run(isolatedParams());
    }), (error) => assertBudgetError(error, scenario === "secondary-generic-cleanup" ? primary : cleanup));
    assert.deepEqual(attempts, ["deepseek/deepseek-v4-pro"]);
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.removed, []);
    await f.service.dispose();
  });
}
