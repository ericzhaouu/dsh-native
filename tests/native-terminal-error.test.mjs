import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { edits as ownershipEdits, transform as applyOwnershipEdit } from "../host-patch/spec.mjs";

const sourceModules = new Map(["harness", "transcript", "reset-boundary", "route"].map((name) => [
  new URL(`../dist/native/${name}.js`, import.meta.url).href,
  new URL(`../src/native/${name}.ts`, import.meta.url),
]));
const sourceHooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return sourceModules.has(url) ? { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText } : next(url, context);
  },
});
// Match the deployed ownership pin in memory only; never patch the shared installation.
const hostEdits = new Map(ownershipEdits.filter((edit) => edit.file.endsWith(".js")).map((edit) => [
  pathToFileURL(realpathSync(new URL(`../node_modules/openclaw/${edit.file}`, import.meta.url))).href, edit,
]));
const hostHooks = registerHooks({
  load(url, context, next) {
    const edit = hostEdits.get(url);
    if (!edit) return next(url, context);
    const source = readFileSync(new URL(url), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), edit.sha256, `exact host source: ${edit.file}`);
    return { format: "module", shortCircuit: true, source: applyOwnershipEdit(source, edit) };
  },
});
after(() => hostHooks.deregister());

// The native host imports public SDK exports that can preload the selector.
const { createNativeHarness } = await import("../dist/native/harness.js");
const { prepareNativeTranscript } = await import("../dist/native/transcript.js");
const { NativeTranscriptError } = await import("../dist/native/reset-boundary.js");
sourceHooks.deregister();

// Exercise the installed runner/selector, not a copied fallback state machine.
const stateDir = resolve("artifacts", `native-terminal-error-${process.pid}`);
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
});
const loadHost = (name) => import(new URL(`../node_modules/openclaw/dist/${name}`, import.meta.url));
const { setLoggerOverride } = await loadHost("logging-CoIcMOSn.js");
setLoggerOverride({ level: "silent", file: resolve(stateDir, "host.log"), consoleLevel: "silent" });
const { t: runWithModelFallback } = await loadHost("model-fallback-runner-DfBb8xXp.js");
const { i: isTranscriptNotContinuableError } = await loadHost("model-fallback-attempt-hBQW6kuE.js");
const { c: selectAgentHarness } = await loadHost("selection-CgLPGlZh.js");
const { t: createRegistry } = await loadHost("registry-empty-55wlVNzO.js");
const { O: setRegistry } = await loadHost("runtime-BL4wZfTq.js");
const { t: AgentHarnessPreflightError, s: resolvePreflightOwner } = await loadHost("errors-70ml6R0Z.js");
const { f: projectAttemptTerminal } = await loadHost("agent-run-terminal-outcome-CigeY75d.js");
function getAttemptFailure(terminal) {
  const projected = projectAttemptTerminal(terminal);
  return projected.failed ? { error: projected.promptError, source: projected.promptErrorSource } : undefined;
}

const HISTORY_MESSAGE = "DSH native transcript: history contains a non-DSH assistant or ambiguous ownership; DSH owns its history. Start a fresh session with /new.";
const user = { role: "user", content: "current request", timestamp: 1, idempotencyKey: "run:user" };
const assistant = {
  role: "assistant", content: [{ type: "text", text: "previous answer" }], timestamp: 2,
  provider: "deepseek", model: "deepseek-v4-pro", api: "openai-completions",
  usage: {}, stopReason: "stop", idempotencyKey: "dsh-native:old:assistant",
};

function fixture(t, mode = "history") {
  const calls = { attempts: [], nativeErrors: [], results: [], writes: 0, provider: 0, cleanup: 0, host: 0 };
  const model = {
    id: "deepseek-v4-pro", name: "fixture", provider: "deepseek", api: "openai-completions",
    baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const cfg = {
    plugins: { enabled: false },
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { runtime: { type: "embedded", harness: "dsh-native" } } },
    },
    models: { providers: {
      deepseek: { api: model.api, baseUrl: model.baseUrl, models: [model, { ...model, id: "deepseek-v4-flash" }] },
      "microsoft-foundry": {
        api: "openai-responses", baseUrl: "https://fallback.invalid",
        models: [{ ...model, id: "gpt-5.6-sol", provider: "microsoft-foundry", api: "openai-responses" }],
      },
    } },
  };
  const entries = [];
  const add = (message) => {
    const entry = { entryId: `e${entries.length}`, parentId: entries.at(-1)?.entryId ?? null,
      seq: entries.length + 1, role: message.role, message, idempotencyKey: message.idempotencyKey };
    entries.push(entry);
  };
  if (mode === "history" || mode === "unsupported-assistant") {
    add({ ...user, content: "previous request", idempotencyKey: "old:user" });
    add(mode === "unsupported-assistant" ? { ...assistant, stopReason: "toolUse" } : assistant);
    if (mode === "history") add({ ...assistant, provider: "openclaw", model: "delivery-mirror",
      idempotencyKey: "old:message-tool:delivery-mirror" });
  }
  const unexpectedWrite = () => { calls.writes++; assert.fail("terminal admission must not write"); };
  const p = {
    sessionId: "terminal-session", sessionKey: "agent:main:terminal-test", agentId: "main", runId: "run",
    sessionFile: "sqlite:terminal-fixture", sessionPersistence: "durable", workspaceDir: process.cwd(),
    prompt: user.content, timeoutMs: 5000, agentHarnessId: "dsh-native", agentHarnessRuntimeOverride: "dsh-native",
    provider: model.provider, modelId: model.id, model, thinkLevel: "off",
    resolvedApiKey: "fixture-not-a-real-key", config: cfg,
    hostCapabilities: { kind: "agent-harness-host-capability", version: 1, assertActive() {} },
    userTurnTranscriptRecorder: {
      resolveMessage: async () => user, hasPersisted: () => mode === "admission",
      getAdmissionReceipt: () => undefined, getPersistedMessage: () => mode === "admission" ? user : undefined,
      isBlocked: () => false, hasRuntimePersistencePending: () => false,
      persistApproved: mode === "late-admission" ? async () => undefined : unexpectedWrite,
      markSentToProvider: unexpectedWrite,
    },
  };
  const transport = {
    readVisibleSessionTranscriptMessageEntries: async () => entries,
    readSessionTranscriptEvents: async () => mode === "reset"
      ? [{ type: "reset", id: "r", parentId: "missing" }]
      : entries.map((entry) => ({ type: "message", id: entry.entryId, parentId: entry.parentId, message: entry.message })),
    appendSessionTranscriptMessageByIdentityStrict: unexpectedWrite,
    publishSessionTranscriptUpdateByIdentity: unexpectedWrite,
    runAgentHarnessBeforeMessageWriteHook: (params) => params.message,
  };
  const cleanupError = new Error("secondary cleanup failure");
  const endHookError = new Error("secondary end-hook failure");
  const runtime = {
    async run() { calls.provider++; assert.fail("admission must fail before provider execution"); },
    async dispose() {},
  };
  const sdk = {
    getModelProviderRequestTransport: () => undefined,
    setActiveEmbeddedRun() {},
    clearActiveEmbeddedRun() { calls.cleanup++; throw cleanupError; },
    async awaitAgentHarnessAgentEndHook() { throw endHookError; },
  };
  const harness = createNativeHarness({
    stateDir, startupTimeoutMs: 1000, shutdownTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
    allowedBaseUrls: [model.baseUrl],
  }, runtime, {
    loadSdk: async () => sdk,
    prepareTranscript: async (params, assertActive) => {
      try {
        const transcript = await prepareNativeTranscript(params, assertActive, transport);
        const persistUser = transcript.persistUser;
        transcript.persistUser = async () => {
          try { await persistUser(); }
          catch (error) { calls.nativeErrors.push(error); throw error; }
        };
        return transcript;
      } catch (error) { calls.nativeErrors.push(error); throw error; }
    },
    async prepareHost() {
      calls.host++;
      assert.equal(mode, "late-admission", "earlier admission failures must not construct tools");
      return {
        tools: [], systemPrompt: "fixture", prompt: p.prompt,
        getReplayState: () => ({ hadPotentialSideEffects: false, replaySafe: true }),
        getToolCounts: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
        async dispose() { throw cleanupError; },
      };
    },
    assertSourceReplySettled: async () => {},
  });
  t.after(() => harness.dispose());
  const registry = createRegistry();
  registry.agentHarnesses.push({ pluginId: "dsh-native", harness });
  setRegistry(registry, "native-terminal-error-test");
  const select = (provider, modelId) => selectAgentHarness({
    config: cfg, agentId: p.agentId, provider, modelId,
    modelProvider: cfg.models.providers[provider], agentHarnessRuntimeOverride: "dsh-native",
  });
  const attempt = async () => {
    const result = await harness.runAttempt(p);
    calls.results.push(result);
    const failure = getAttemptFailure(result.terminal);
    assert.ok(failure, "fixture must produce a host-visible failure");
    assert.equal(failure.error, calls.nativeErrors.at(-1), failure.error?.stack);
    assert.equal(failure.source, "precheck");
    assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: true });
    return result;
  };
  const fallback = (run, options = {}) => runWithModelFallback({
    cfg, agentId: p.agentId, provider: model.provider, model: model.id,
    fallbacksOverride: ["microsoft-foundry/gpt-5.6-sol"], skipAuthProfileRuntime: true, manifestPlugins: [],
    run: async (provider, modelId) => {
      calls.attempts.push(`${provider}/${modelId}`);
      select(provider, modelId);
      return run(provider, modelId);
    },
    ...options,
  });
  return { calls, p, transport, select, attempt, fallback, cleanupError, endHookError };
}

test("control: the genuine runner reproduces the plain-error masking by an ownerless incompatible preflight", async (t) => {
  const f = fixture(t);
  const root = new Error(HISTORY_MESSAGE);
  await assert.rejects(f.fallback(() => { throw root; }), (error) => {
    assert.ok(error instanceof AgentHarnessPreflightError, error.stack);
    assert.equal(resolvePreflightOwner(error), undefined);
    assert.notEqual(error, root);
    assert.match(error.message, /microsoft-foundry\/gpt-5.6-sol/);
    return true;
  });
  assert.deepEqual(f.calls.attempts, ["deepseek/deepseek-v4-pro", "microsoft-foundry/gpt-5.6-sol"]);
});

for (const mode of ["history", "unsupported-assistant", "admission", "late-admission", "reset"]) {
  for (const propagation of ["throw", "classified-result"]) {
    test(`${mode} survives harness cleanup and host ${propagation} with one fallback attempt`, async (t) => {
      const f = fixture(t, mode);
      assert.throws(() => f.select("microsoft-foundry", "gpt-5.6-sol"), AgentHarnessPreflightError);
      const run = async () => {
        const result = await f.attempt();
        if (propagation === "throw") throw getAttemptFailure(result.terminal).error;
        return result;
      };
      await assert.rejects(f.fallback(run, propagation === "classified-result" ? {
        classifyResult: ({ result }) => ({ error: getAttemptFailure(result.terminal).error }),
      } : {}), (error) => {
        assert.ok(error instanceof NativeTranscriptError, error.stack);
        assert.equal(isTranscriptNotContinuableError(error), true);
        assert.equal(error, f.calls.nativeErrors[0]);
        assert.equal(error, f.calls.results[0].terminal.error);
        if (mode === "history") assert.equal(error.message, HISTORY_MESSAGE);
        if (mode === "unsupported-assistant") {
          assert.equal(error.cause.message, "DSH native transcript: expected a canonical final text assistant message");
          assert.ok(error.cause instanceof NativeTranscriptError);
        }
        assert.notEqual(error, f.cleanupError);
        assert.notEqual(error, f.endHookError);
        return true;
      });
      assert.deepEqual(f.calls.attempts, ["deepseek/deepseek-v4-pro"]);
      assert.equal(f.calls.cleanup, 1);
      assert.equal(f.calls.writes, 0);
      assert.equal(f.calls.provider, 0);
      assert.equal(f.calls.results[0].assistantTranscriptOwned, undefined);
      assert.deepEqual(f.calls.results[0].assistantTexts, []);
    });
  }
}

for (const [name, error, reason] of [
  ["provider rate limit", Object.assign(new Error("rate limit exceeded"), { status: 429 }), "rate_limit"],
  ["provider timeout", Object.assign(new Error("provider request timed out"), { code: "ETIMEDOUT" }), "timeout"],
  ["unknown external error", new Error("unclassified external failure"), "unknown"],
]) {
  test(`${name} still reaches a compatible fallback in the genuine host runner`, async (t) => {
    const f = fixture(t);
    const result = await f.fallback((_provider, model) => {
      if (model === "deepseek-v4-pro") throw error;
      return "recovered";
    }, { fallbacksOverride: ["deepseek/deepseek-v4-flash"] });
    assert.equal(isTranscriptNotContinuableError(error), false);
    assert.equal(result.outcome, "completed");
    assert.equal(result.result, "recovered");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].reason, reason);
    assert.deepEqual(f.calls.attempts, ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]);
  });
}

test("transcript I/O errors retain their cause through harness catch and still allow compatible fallback", async (t) => {
  const f = fixture(t);
  const cause = new Error("socket reset");
  const error = Object.assign(new Error("transcript read timed out", { cause }), { code: "ETIMEDOUT" });
  f.transport.readSessionTranscriptEvents = async () => { throw error; };
  const result = await f.fallback(async (_provider, model) => {
    if (model !== "deepseek-v4-pro") return "recovered";
    await f.attempt();
    throw f.calls.results[0].terminal.error;
  }, { fallbacksOverride: ["deepseek/deepseek-v4-flash"] });
  assert.equal(result.result, "recovered");
  assert.equal(f.calls.nativeErrors[0], error);
  assert.equal(f.calls.results[0].terminal.error.cause, cause);
  assert.equal(isTranscriptNotContinuableError(error), false);
  assert.equal(result.attempts[0].reason, "timeout");
  assert.equal(f.calls.attempts.length, 2);
});

test("external cancellation remains an abort rather than a transcript error", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  f.p.abortSignal = controller.signal;
  f.transport.readSessionTranscriptEvents = async () => { controller.abort(reason); throw reason; };
  await assert.rejects(f.fallback(async () => {
    const result = await f.attempt();
    assert.equal(result.terminal.kind, "aborted");
    assert.equal(result.terminal.source, "external");
    throw getAttemptFailure(result.terminal).error;
  }, { abortSignal: controller.signal }), (error) => error === reason);
  assert.equal(isTranscriptNotContinuableError(reason), false);
  assert.equal(f.calls.attempts.length, 1);
});
