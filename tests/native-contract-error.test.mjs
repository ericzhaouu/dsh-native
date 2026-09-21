import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { edits as ownershipEdits, transform as applyOwnershipEdit } from "../host-patch/spec.mjs";

const stateDir = resolve("artifacts", `native-contract-error-${process.pid}`);
const isolatedEnv = {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: resolve(stateDir, "absent-config.json"),
  OPENCLAW_LOG_LEVEL: "silent",
};
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

// Install the existing ownership pin in memory before loading the public SDK.
// Node resolves linked installations to real paths; a lexical node_modules URL misses them.
const hostEdits = new Map(ownershipEdits.filter((edit) => edit.file.endsWith(".js")).map((edit) => [
  pathToFileURL(realpathSync(new URL(`../node_modules/openclaw/${edit.file}`, import.meta.url))).href, edit,
]));
const loadedEdits = new Set();
const sourceModules = new Map([
  "native/harness", "native/host", "native/route", "native/transcript", "native/reset-boundary",
  "native/source-reply", "native/source-reply-ownership", "native/tool-bridge", "preparation",
].map((name) => [
  new URL(`../dist/${name}.js`, import.meta.url).href,
  new URL(`../src/${name}.ts`, import.meta.url),
]));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const edit = hostEdits.get(url);
    if (edit) {
      const source = readFileSync(new URL(url), "utf8");
      assert.equal(createHash("sha256").update(source).digest("hex"), edit.sha256, `exact host source: ${edit.file}`);
      loadedEdits.add(edit.file);
      return { format: "module", shortCircuit: true, source: applyOwnershipEdit(source, edit) };
    }
    if (sourceModules.has(url)) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText,
    };
    return next(url, context);
  },
});
after(() => hooks.deregister());

const loadHost = (name) => import(new URL(`../node_modules/openclaw/dist/${name}`, import.meta.url));
const { setLoggerOverride } = await loadHost("logging-CoIcMOSn.js");
setLoggerOverride({ level: "silent", file: resolve(stateDir, "host.log"), consoleLevel: "silent" });
const { AgentHarnessPreflightError, OPENCLAW_VERSION } = await import("openclaw/plugin-sdk/agent-harness-runtime");
const { t: runWithModelFallback } = await loadHost("model-fallback-runner-DfBb8xXp.js");
const { i: isTranscriptNotContinuableError } = await loadHost("model-fallback-attempt-hBQW6kuE.js");
const { u: isNonProviderRuntimeCoordinationError, m: resolveModelFallbackError } = await loadHost("failover-error-BkNxlp8A.js");
const { i: isAgentHarnessPreflightError, o: recordPreflightOwner, s: resolvePreflightOwner } = await loadHost("errors-70ml6R0Z.js");
const { c: selectAgentHarness } = await loadHost("selection-CgLPGlZh.js");
const { t: createRegistry } = await loadHost("registry-empty-55wlVNzO.js");
const { O: setRegistry } = await loadHost("runtime-BL4wZfTq.js");
const { f: projectAttemptTerminal } = await loadHost("agent-run-terminal-outcome-CigeY75d.js");
const { createNativeHarness } = await import("../dist/native/harness.js");
const { assertNativeHostSupported, prepareNativeHost } = await import("../dist/native/host.js");

const MESSAGE = "DSH native host does not support scheduled tool authority";
const PRIMARY = "deepseek/deepseek-v4-pro";
const INCOMPATIBLE = "microsoft-foundry/gpt-5.6-sol";
const COMPATIBLE = "deepseek/deepseek-v4-flash";

function fixture(t, fields = {}) {
  const calls = { attempts: [], errors: [], results: [], prepareHost: 0, cleanup: 0, endHook: 0, writes: 0, provider: 0, tools: 0 };
  const model = {
    id: "deepseek-v4-pro", name: "fixture", provider: "deepseek", api: "openai-completions",
    baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const cfg = {
    plugins: { enabled: false },
    agents: {
      defaults: { model: { primary: PRIMARY } },
      entries: { main: { runtime: { type: "embedded", harness: "dsh-native" } } },
    },
    models: { providers: {
      deepseek: { api: model.api, baseUrl: model.baseUrl, models: [model, { ...model, id: "deepseek-v4-flash" }] },
      "microsoft-foundry": { api: "openai-responses", baseUrl: "https://fallback.invalid",
        models: [{ ...model, id: "gpt-5.6-sol", provider: "microsoft-foundry", api: "openai-responses" }] },
    } },
  };
  const unexpectedWrite = () => { calls.writes++; assert.fail("preflight must not write"); };
  const p = {
    sessionId: "contract-session", sessionKey: "agent:main:contract-test", agentId: "main", runId: "run",
    sessionFile: "sqlite:contract-fixture", sessionPersistence: "durable", workspaceDir: process.cwd(),
    prompt: "fixture request", timeoutMs: 5000, agentHarnessId: "dsh-native", agentHarnessRuntimeOverride: "dsh-native",
    provider: model.provider, modelId: model.id, model, thinkLevel: "off",
    resolvedApiKey: "fixture-not-a-real-key", config: cfg,
    hostCapabilities: {
      kind: "agent-harness-host-capability", version: 1, assertActive() {},
      bindToolSurface() { calls.tools++; assert.fail("preflight must not bind tools"); },
    },
    ...fields,
  };
  const cleanupError = new Error("secondary cleanup failure");
  const endHookError = new Error("secondary end-hook failure");
  const harness = createNativeHarness({
    stateDir, startupTimeoutMs: 1000, shutdownTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
    allowedBaseUrls: [model.baseUrl],
  }, {
    async run() { calls.provider++; assert.fail("preflight must not execute a provider"); },
    async dispose() {},
  }, {
    loadSdk: async () => ({
      getModelProviderRequestTransport: () => undefined,
      setActiveEmbeddedRun() {},
      clearActiveEmbeddedRun() { calls.cleanup++; throw cleanupError; },
      async awaitAgentHarnessAgentEndHook() { calls.endHook++; throw endHookError; },
    }),
    prepareTranscript: async () => ({
      messages: [], contextMessages: [], persistUser: unexpectedWrite, appendAssistant: unexpectedWrite,
    }),
    assertSourceReplySettled: async () => {},
    async prepareHost(...args) {
      calls.prepareHost++;
      try { return await prepareNativeHost(...args); }
      catch (error) { calls.errors.push(error); throw error; }
    },
  });
  t.after(() => harness.dispose());
  const registry = createRegistry();
  registry.agentHarnesses.push({ pluginId: "dsh-native", harness });
  setRegistry(registry, "native-contract-error-test");
  const select = (provider, modelId) => selectAgentHarness({
    config: cfg, agentId: p.agentId, provider, modelId,
    modelProvider: cfg.models.providers[provider], agentHarnessRuntimeOverride: "dsh-native",
  });
  const attempt = async () => {
    const result = await harness.runAttempt(p);
    calls.results.push(result);
    const projected = projectAttemptTerminal(result.terminal);
    assert.equal(projected.failed, true);
    assert.equal(projected.promptErrorSource, "precheck");
    assert.equal(projected.promptError, calls.errors.at(-1), projected.promptError?.stack);
    assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: true });
    return result;
  };
  const fallback = (run, options = {}) => runWithModelFallback({
    cfg, agentId: p.agentId, provider: model.provider, model: model.id,
    fallbacksOverride: [INCOMPATIBLE], skipAuthProfileRuntime: true, manifestPlugins: [],
    run: async (provider, modelId) => {
      calls.attempts.push(`${provider}/${modelId}`);
      select(provider, modelId);
      return run(provider, modelId);
    },
    ...options,
  });
  return { calls, p, select, attempt, fallback, cleanupError, endHookError };
}

test("the installed public SDK and realpath ownership hooks are the genuine 2026.9.2 contract", () => {
  assert.equal(OPENCLAW_VERSION, "2026.9.2");
  assert.ok(loadedEdits.has("dist/model-runtime-policy-BAKiaBCi.js"));
  assert.ok(loadedEdits.has("dist/model-fallback-attempt-hBQW6kuE.js"));
  const scoped = new AgentHarnessPreflightError("harness-local rejection", { scope: "harness" });
  recordPreflightOwner(scoped, "dsh-native");
  assert.equal(resolvePreflightOwner(scoped), "dsh-native", "harness scope permits a different runtime");
});

test("control: the genuine runner masks an ordinary scheduled-contract Error with incompatible-provider preflight", async (t) => {
  const f = fixture(t);
  const original = new Error(MESSAGE);
  await assert.rejects(f.fallback(() => { throw original; }), (error) => {
    assert.ok(error instanceof AgentHarnessPreflightError, error.stack);
    assert.notEqual(error, original);
    assert.match(error.message, /microsoft-foundry\/gpt-5.6-sol/);
    return true;
  });
  assert.deepEqual(f.calls.attempts, [PRIMARY, INCOMPATIBLE]);
});

for (const fields of [
  { scheduledToolPolicy: { mode: "trusted" } },
  { scheduledRuntimeAuthority: {} },
  { scheduledToolPolicy: { mode: "trusted" }, scheduledRuntimeAuthority: {} },
]) {
  for (const propagation of ["throw", "classified-result"]) {
    test(`${Object.keys(fields).join("+")} survives cleanup and ${propagation} without a second candidate`, async (t) => {
      const f = fixture(t, fields);
      const expectedFields = structuredClone(fields);
      assert.throws(() => f.select("microsoft-foundry", "gpt-5.6-sol"), AgentHarnessPreflightError);
      await assert.rejects(f.fallback(async () => {
        const result = await f.attempt();
        if (propagation === "throw") throw projectAttemptTerminal(result.terminal).promptError;
        return result;
      }, propagation === "classified-result" ? {
        classifyResult: ({ result }) => ({ error: projectAttemptTerminal(result.terminal).promptError }),
      } : {}), (error) => {
        assert.equal(error, f.calls.errors[0]);
        assert.equal(error, f.calls.results[0].terminal.error);
        assert.ok(error instanceof AgentHarnessPreflightError);
        assert.equal(isAgentHarnessPreflightError(error), true);
        assert.equal(isNonProviderRuntimeCoordinationError(error), true);
        assert.deepEqual(resolveModelFallbackError(error), { kind: "coordination", error });
        assert.equal(isTranscriptNotContinuableError(error), false);
        assert.equal(error.scope, undefined);
        recordPreflightOwner(error, "dsh-native");
        assert.equal(resolvePreflightOwner(error), undefined, "lifecycle must not enable harness substitution");
        assert.equal(error.message, MESSAGE);
        assert.ok(error.cause instanceof Error);
        assert.equal(error.cause.message, MESSAGE);
        assert.match(error.cause.stack, /assertNativeHostSupported/);
        assert.notEqual(error, f.cleanupError);
        assert.notEqual(error, f.endHookError);
        return true;
      });
      assert.deepEqual(f.calls.attempts, [PRIMARY]);
      assert.equal(f.calls.prepareHost, 1);
      assert.equal(f.calls.cleanup, 1);
      assert.equal(f.calls.endHook, 1);
      assert.equal(f.calls.writes, 0);
      assert.equal(f.calls.tools, 0);
      assert.equal(f.calls.provider, 0);
      assert.equal(f.calls.results[0].assistantTranscriptOwned, undefined);
      assert.deepEqual(f.calls.results[0].assistantTexts, []);
      for (const [key, value] of Object.entries(fields)) {
        assert.equal(f.p[key], value, "authority must not be stripped or replaced");
        assert.deepEqual(value, expectedFields[key], "authority must not be mutated");
      }
    });
  }
}

for (const [name, error, reason] of [
  ["provider timeout", Object.assign(new Error("provider request timed out"), { code: "ETIMEDOUT" }), "timeout"],
  ["provider rate limit", Object.assign(new Error("rate limit exceeded"), { status: 429 }), "rate_limit"],
  ["matching error text", new Error(MESSAGE), "unknown"],
  ["matching name/code", Object.assign(new Error(MESSAGE), { name: "AgentHarnessPreflightError", code: "AgentHarnessPreflightError" }), "unknown"],
  ["model JSON", { name: "AgentHarnessPreflightError", message: MESSAGE }, "unknown"],
]) {
  test(`${name} is not trusted preflight and still reaches a compatible fallback`, async (t) => {
    const f = fixture(t);
    assert.equal(isAgentHarnessPreflightError(error), false);
    assert.equal(isNonProviderRuntimeCoordinationError(error), false);
    assert.equal(isTranscriptNotContinuableError(error), false);
    const result = await f.fallback((_provider, model) => {
      if (model === "deepseek-v4-pro") throw error;
      return "recovered";
    }, { fallbacksOverride: [COMPATIBLE] });
    assert.equal(result.outcome, "completed");
    assert.equal(result.result, "recovered");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].reason, reason);
    assert.deepEqual(f.calls.attempts, [PRIMARY, COMPATIBLE]);
  });
}

test("model text naming the preflight class remains ordinary successful output", async (t) => {
  const f = fixture(t);
  const text = `AgentHarnessPreflightError: ${MESSAGE}`;
  assert.doesNotThrow(() => assertNativeHostSupported({ ...f.p, prompt: text, extraSystemPrompt: text }));
  const result = await f.fallback(() => text);
  assert.equal(result.result, text);
  assert.deepEqual(f.calls.attempts, [PRIMARY]);
});

test("external I/O during host precheck retains the original error/cause and remains fallback-eligible", async (t) => {
  const f = fixture(t);
  const cause = new Error("socket reset");
  const error = Object.assign(new Error("host I/O timed out", { cause }), { code: "ETIMEDOUT" });
  Object.defineProperty(f.p.hostCapabilities, "bindToolSurface", { get() { throw error; } });
  const result = await f.fallback(async (_provider, model) => {
    if (model !== "deepseek-v4-pro") return "recovered";
    const result = await f.attempt();
    throw projectAttemptTerminal(result.terminal).promptError;
  }, { fallbacksOverride: [COMPATIBLE] });
  assert.equal(result.result, "recovered");
  assert.equal(f.calls.errors[0], error);
  assert.equal(f.calls.results[0].terminal.error, error);
  assert.equal(error.cause, cause);
  assert.equal(isNonProviderRuntimeCoordinationError(error), false);
  assert.equal(isTranscriptNotContinuableError(error), false);
  assert.equal(result.attempts[0].reason, "timeout");
  assert.deepEqual(f.calls.attempts, [PRIMARY, COMPATIBLE]);
});

test("caller cancellation stays external abort, not unsupported host or transcript corruption", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  f.p.abortSignal = controller.signal;
  Object.defineProperty(f.p.hostCapabilities, "bindToolSurface", {
    get() { controller.abort(reason); throw reason; },
  });
  await assert.rejects(f.fallback(async () => {
    const result = await f.attempt();
    assert.equal(result.terminal.kind, "aborted");
    assert.equal(result.terminal.source, "external");
    throw projectAttemptTerminal(result.terminal).promptError;
  }, { abortSignal: controller.signal }), (error) => error === reason);
  assert.equal(isNonProviderRuntimeCoordinationError(reason), false);
  assert.equal(isTranscriptNotContinuableError(reason), false);
  assert.equal(f.calls.results[0].terminal.failure.error, reason);
  assert.deepEqual(f.calls.attempts, [PRIMARY]);
});
