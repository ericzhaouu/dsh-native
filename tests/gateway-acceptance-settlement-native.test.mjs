import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGatewayAcceptanceAdapter, readRuntimeBudgetProof } from "../scripts/lib/gateway-acceptance-adapter.mjs";
import { startResponsesServer } from "./fixtures/responses-server.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtRoot = resolve(process.env.DSH_TEST_BUILT_ROOT ?? packageRoot);
const scratchRoot = resolve(process.env.DSH_ACCEPTANCE_TEST_ROOT ?? join(packageRoot, "artifacts"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const textOf = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readRows = async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const canonicalText = "Native settled ✓ 文本.";
const fixtureKey = "synthetic-settlement-fixture-key";
const agentId = "settlement-fixture";
const attemptBudget = {
  maxModelRequests: 4, maxInputTokens: 131072, maxOutputTokens: 256, maxToolCalls: 1, maxDurationMs: 45000,
};
const caseBudget = {
  maxModelRequests: 12, maxInputTokens: 393216, maxOutputTokens: 768, maxToolCalls: 3, maxDurationMs: 240000,
};
const turnUsage = {
  modelRequests: 2, inputTokens: 34, outputTokens: 20, cacheReadTokens: 6, cacheWriteTokens: 0,
  toolCalls: 0, userTurns: 1, priced: false,
};
const totalUsage = (turns) => Object.fromEntries(Object.entries(turnUsage)
  .map(([key, value]) => [key, key === "priced" ? false : value * turns]));

async function assertAbsent(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

async function nativeRows(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name === "session.jsonl") files.push(child);
    }
  }
  await visit(join(directory, "home"));
  assert.equal(files.length, 1, "the real child must persist one native session transcript");
  return readRows(files[0]);
}

function assertDiagnosis(diagnosis) {
  const identity = (text, trailing, lf) => ({
    sha256: hash(text), utf8Bytes: Buffer.byteLength(text),
    whitespace: { leadingUtf8Bytes: 0, trailingUtf8Bytes: trailing, lf, cr: 0, tabs: 0, spaces: 3 },
  });
  assert.deepEqual(diagnosis, {
    code: "GATEWAY_FINAL_CANONICAL_MISMATCH",
    actual: identity(`${canonicalText}\n`, 1, 1),
    canonical: identity(canonicalText, 0, 0),
    firstDiffUtf8Byte: Buffer.byteLength(canonicalText),
  });
  assert.ok(diagnosis.firstDiffUtf8Byte > canonicalText.length, "the offset is UTF-8 bytes, not UTF-16 units");
  assert.doesNotMatch(JSON.stringify(diagnosis), /Native settled|文本|synthetic-settlement/);
}

async function fixture(t) {
  const root = join(scratchRoot, `gateway-settlement-native-${randomUUID()}`);
  const nativeStateDir = join(root, "native");
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const sessions = new Map();
  const children = [];
  const adapters = [];
  const serverErrors = [];
  let active;
  let harness;
  let spawnMock;
  let server;
  const environment = {
    OPENCLAW_HOME: join(root, "host-home"), OPENCLAW_STATE_DIR: join(root, "host-state"),
    OPENCLAW_CONFIG_PATH: join(root, "absent-host-config.json"), OPENCLAW_LOG_LEVEL: "silent",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const localBoundary = pathToFileURL(join(packageRoot, "dist", "native", "reset-boundary.js")).href;
  const builtBoundary = pathToFileURL(join(builtRoot, "dist", "native", "reset-boundary.js")).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL && specifier.startsWith(".") &&
          new URL(specifier, context.parentURL).href === localBoundary) {
        return { url: builtBoundary, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  t.after(async () => {
    try {
      for (const adapter of adapters) await adapter.close();
      await harness?.dispose();
      assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
        "native children must really exit before fixture cleanup");
    } finally {
      hooks.deregister();
      spawnMock?.mock.restore();
      syncBuiltinESMExports();
      await server?.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  server = await startResponsesServer(async ({ body, request, response, tool, text, finish }) => {
    try {
      assert.ok(active, "a request must belong to the current real native attempt");
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      assert.equal(body.model, "gpt-6-astra");
      if (active.requests++ === 0) {
        assert.deepEqual(body.tools.map((entry) => entry.name), ["dsh_prepare_task"]);
        tool("dsh_prepare_task", {
          version: 1, revision: active.revision, mode: "chat", task: "none",
          goal: "", deliverables: [], constraints: [], assumptions: [], unresolved: [],
          question: "", enhancedPrompt: "", evidence: { source: "current", quote: active.prompt },
        }, `prepare-${active.runId}`);
      } else {
        assert.equal(active.requests, 2, "no retries or unaccounted provider steps are allowed");
        assert.deepEqual(body.tools ?? [], []);
        assert.ok(body.input.some((entry) => entry.type === "function_call_output"));
        text(canonicalText);
      }
      finish({
        input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0 },
      });
    } catch (error) {
      serverErrors.push(error);
      response.destroy(error);
    }
  });

  // Only the network boundary is instrumented: DSH CLI, bridge, ledger and persistence stay built code.
  const preload = `data:text/javascript;base64,${Buffer.from(`
    import net from "node:net";
    import { syncBuiltinESMExports } from "node:module";
    const allowed = new URL(${JSON.stringify(server.baseUrl)});
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== allowed.origin || !url.pathname.endsWith("/responses"))
        throw new Error("Native settlement fixture forbids non-fixture fetch");
      return fetch(input, { ...init, redirect: "error" });
    };
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const options = typeof first === "object" ? first : { port: first, host: args[1] };
      if (options.host !== "127.0.0.1" || Number(options.port) !== Number(allowed.port) || options.path)
        throw new Error("Native settlement fixture forbids non-fixture sockets");
      return connect.apply(this, args);
    };
    syncBuiltinESMExports();
  `).toString("base64")}`;
  const spawn = childProcess.spawn;
  spawnMock = t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.equal(resolve(args[0]), join(builtRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    assert.equal(options.env.OPENCLAW_DSH_MODEL_KEY, fixtureKey);
    assert.equal(options.env.DSH_TELEMETRY, "0");
    for (const key of ["NODE_OPTIONS", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) {
      assert.equal(options.env[key], undefined, "native children must not inherit operator auth or loaders");
    }
    const child = spawn(command, ["--import", preload, ...args], options);
    const record = { child, stderr: "", directory: options.cwd };
    child.stderr.on("data", (chunk) => { record.stderr = (record.stderr + chunk.toString()).slice(-8000); });
    children.push(record);
    return child;
  });
  syncBuiltinESMExports();

  const load = (name) => import(pathToFileURL(join(builtRoot, "dist", ...name.split("/"))).href);
  const [{ parseDshConfig }, { createDshRuntime }, { createNativeHarness }] = await Promise.all([
    load("config.js"), load("runtime.js"), load("native/harness.js"),
  ]);
  const config = parseDshConfig({
    stateDir: nativeStateDir, allowedCopilotBaseUrls: [server.baseUrl],
    startupTimeoutMs: 30000, shutdownTimeoutMs: 10000, streamIdleTimeoutMs: 10000,
    operationalBudget: attemptBudget,
    taskPreparation: { agentIds: [agentId], executionTools: [], skillAllowlist: [] },
  });
  const model = {
    id: "gpt-6-astra", name: "Local native settlement fixture", provider: "github-copilot",
    api: "openai-responses", baseUrl: server.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 128,
  };
  const hostConfig = { plugins: { entries: { "dsh-native": { config } } } };
  const sdk = {
    getModelProviderRequestTransport: () => undefined,
    resolveSessionAgentIds: () => ({ sessionAgentId: agentId }),
    setActiveEmbeddedRun() {}, clearActiveEmbeddedRun() {}, emitAgentEvent() {},
    runAgentHarnessLlmInputHook() {}, runAgentHarnessLlmOutputHook() {},
    async runAgentHarnessBeforeAgentFinalizeHook() { return { action: "continue" }; },
    async awaitAgentHarnessAgentEndHook() {},
  };
  harness = createNativeHarness(config, createDshRuntime(config), {
    loadSdk: async () => sdk,
    prepareHost: async (params) => ({
      systemPrompt: "Reply to the user without accessing files or external services.",
      prompt: params.prompt, tools: [],
      async executeTool() { assert.fail("the fixture cannot execute host tools"); },
      getReplayState: () => ({ hadPotentialSideEffects: false, replaySafe: true }),
      getToolCounts: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
      async dispose() {},
    }),
    prepareTranscript: async (params) => {
      const session = sessions.get(params.sessionKey);
      const messages = session.raw.map((row) => row.message);
      const append = async (message) => {
        const row = { id: randomUUID(), parentId: session.raw.at(-1)?.id ?? null, type: "message", message };
        await appendFile(session.file, `${JSON.stringify(row)}\n`);
        session.raw.push(row);
        messages.push(message);
      };
      return {
        nativeStateId: session.id, messages, contextMessages: messages,
        async persistUser() { await append({ role: "user", content: params.prompt, timestamp: Date.now() }); },
        markSentToProvider() {},
        async persistAssistant(assistant) {
          const idempotencyKey = `dsh-native:${params.runId}:assistant`;
          const message = { ...structuredClone(assistant), idempotencyKey };
          await append(message);
          return { owned: true, message, idempotencyKey };
        },
      };
    },
  });

  async function assertGenerated(session, params, result) {
    assert.equal(result.terminal.kind, "ok",
      `${result.terminal.error?.stack ?? JSON.stringify(result.terminal)}\n${children.at(-1)?.stderr ?? ""}`);
    assert.equal(active.requests, 2);
    assert.deepEqual(serverErrors, []);
    const directory = join(nativeStateDir, hash(session.id));
    const binding = await readJson(join(directory, "binding.json"));
    assert.equal(binding.status, "ready");
    assert.equal(binding.lastRunId, params.idempotencyKey);
    assert.deepEqual(binding.consumedRunIds, [...session.runs, params.idempotencyKey]);
    assert.equal(binding.taskPreparation.state.mode, "chat");
    assert.equal(binding.taskPreparation.state.sourceRunId, params.idempotencyKey);
    for (const name of ["owner.lock", "source-reply.lock"]) await assertAbsent(join(directory, name));
    for (const key of ["budgetFailure", "failureDiagnostic", "pendingCompact"]) assert.equal(Object.hasOwn(binding, key), false);
    const expected = { runId: params.idempotencyKey, sessionKey: session.id, agentId, operationalBudget: attemptBudget, settled: true };
    const proof = await readRuntimeBudgetProof(directory, expected);
    assert.equal(proof.usageStatus, "complete");
    assert.equal(proof.hardLimitsVerified, true);
    assert.equal(proof.quiescent, true);
    assert.deepEqual(proof.usage, { ...turnUsage, userTurns: 0 });
    const runtimeConfig = await readJson(join(directory, "operational-budget-config.json"));
    assert.deepEqual(runtimeConfig.operationalBudget, attemptBudget);
    assert.equal(proof.configSha256, hash(JSON.stringify(runtimeConfig)));
    for (const name of ["operational-budget-config.json", "operational-budget-ledger.json"]) {
      assert.equal(await readFile(join(directory, name), "utf8"),
        await readFile(join(directory, "budgets", hash(params.idempotencyKey), name), "utf8"));
    }
    const rows = await nativeRows(directory);
    const turn = rows.slice(rows.findLastIndex((row) => row.type === "turn/start"));
    assert.equal(turn[0]?.type, "turn/start");
    assert.ok(turn.some((row) => row.type === "turn/end" && row.data.turn === turn[0].data.turn));
    assert.equal(turn.filter((row) => row.type === "step/start").length, 2);
    const route = turn.findLast((row) => row.type === "request/header").data.header.config;
    assert.equal(route.provider, "github-copilot");
    assert.equal(route.model, "gpt-6-astra");
    assert.deepEqual(turn.filter((row) => row.type === "tool/call").map((row) => row.data.name), ["dsh_prepare_task"]);
    assert.ok(JSON.stringify(turn).includes(canonicalText), "canonical bytes must also exist in actual native rows");
    const canonical = session.raw.at(-1).message;
    assert.deepEqual(canonical, result.lastAssistant, "Gateway must commit the real harness assistant, not a synthetic answer");
    assert.equal(textOf(canonical), canonicalText);
    assert.equal(canonical.idempotencyKey, `dsh-native:${params.idempotencyKey}:assistant`);
    assert.equal(children.at(-1).directory, directory);
    assert.ok(children.at(-1).child.pid);
    assert.ok(children.at(-1).child.exitCode !== null || children.at(-1).child.signalCode !== null);
    session.runs.push(params.idempotencyKey);
    const generated = { directory, binding, proof, runtimeConfig, canonical, rows, session, params };
    return generated;
  }

  async function gateway({ trailingLfAt = [], mutate, mutateOnRecovery } = {}) {
    const events = [];
    const calls = [];
    const reported = [];
    const generated = [];
    const client = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "sessions.create") {
          const id = randomUUID();
          const file = join(root, `canonical-${id}.jsonl`);
          await writeFile(file, "");
          sessions.set(params.key, { id, file, raw: [], runs: [], inspections: 0 });
          return { ok: true, key: params.key, entry: { sessionId: id, permissionMode: "read-only" } };
        }
        if (method === "chat.send") {
          const session = sessions.get(params.sessionKey);
          assert.ok(session);
          assert.equal(params.agentId, agentId);
          assert.equal(params.expectedPermissionMode, "read-only");
          active = { runId: params.idempotencyKey, revision: session.runs.length, prompt: params.message, requests: 0 };
          const result = await harness.runAttempt({
            sessionId: session.id, sessionKey: params.sessionKey, runId: params.idempotencyKey, agentId,
            sessionFile: session.file, workspaceDir, prompt: params.message, timeoutMs: 60000,
            provider: model.provider, modelId: model.id, model, resolvedApiKey: fixtureKey, thinkLevel: "off",
            config: hostConfig, agentHarnessId: "dsh-native", agentHarnessRuntimeOverride: "dsh-native",
            hostCapabilities: { kind: "agent-harness-host-capability", version: 1, assertActive() {} },
          });
          const evidence = await assertGenerated(session, params, result);
          generated.push(evidence);
          await mutate?.(evidence);
          const delivered = textOf(evidence.canonical) + (trailingLfAt.includes(session.runs.length) ? "\n" : "");
          events.push({ event: "chat", payload: { sessionKey: params.sessionKey, runId: params.idempotencyKey,
            state: "final", message: { ...structuredClone(evidence.canonical), content: delivered } } });
          active = undefined;
          return { status: "started", runId: params.idempotencyKey };
        }
        if (method === "chat.history") {
          const session = sessions.get(params.sessionKey);
          return { sessionId: session.id, inFlightRun: false,
            messages: session.raw.filter((row) => row.message.role === "assistant").map((row) => structuredClone(row.message)) };
        }
        if (method === "chat.abort") return { ok: true };
        assert.fail(`Unexpected Gateway method: ${method}`);
      },
      async stopAndWait() {},
    };
    const adapter = await createGatewayAcceptanceAdapter({
      config: {
        hostRoot: join(builtRoot, "node_modules", "openclaw"), configPath: environment.OPENCLAW_CONFIG_PATH,
        stateDir: environment.OPENCLAW_STATE_DIR, nativeStateDir, gatewayUrl: "ws://127.0.0.1:18789",
        agentMap: { scout: agentId }, allowedAgentIds: [agentId], ownedSessionPrefix: "acceptance-settlement-native",
      },
      events,
      connectionFactory: async () => ({
        client, hostConfig, assertHealthy() {},
        readTranscript: async ({ sessionKey }) => {
          const session = sessions.get(sessionKey);
          if (++session.inspections === 2) await mutateOnRecovery?.(generated.at(-1));
          return readRows(session.file);
        },
      }),
    });
    adapters.push(adapter);
    const context = () => ({
      runId: randomUUID(), runDir: join(root, `campaign-${randomUUID()}`),
      signal: new AbortController().signal, caseBudget,
      reportUsage: (usage) => reported.push(structuredClone(usage)),
    });
    return { adapter, context, generated, calls, reported };
  }
  return { gateway, children, server, serverErrors };
}

const task = (id, turns = ["Say hello."]) => ({
  id, agentProfile: "scout", category: "business", prompt: turns[0], turns,
  limits: { timeoutMs: 240000 },
});

test("dist-native STEP3 exact final succeeds; trailing LF fails judgment but settles once and unlocks", { timeout: 300000 }, async (t) => {
  const f = await fixture(t);
  const g = await f.gateway({ trailingLfAt: [2] });
  const item = task("settled-lf", ["Say hello.", "Say hello again.", "This third turn must never run."]);
  const context = g.context();
  const result = await g.adapter.executeCase(item, context);
  assert.equal(result.executionStatus, "failed");
  assert.equal(result.businessResult, "failed");
  assert.equal(result.error.code, "GATEWAY_FINAL_CANONICAL_MISMATCH");
  assert.equal(result.outputText, `${canonicalText}\n`, "the mismatch must not be silently trimmed");
  assertDiagnosis(result.diagnosis);
  assert.deepEqual(result.turns.map((turn) => turn.executionStatus), ["completed", "failed"]);
  assert.equal(result.turns[0].outputText, canonicalText);
  assert.equal(result.turns[1].businessResult, "failed");
  assert.deepEqual(result.usage, totalUsage(2));
  assert.equal(result.budgetAccounting, undefined, "complete settlement must not be downgraded to unknown usage");
  assert.deepEqual(g.reported, [turnUsage, turnUsage], "exact and recovered turns each report once");
  assert.deepEqual(result.sideEffects, []);
  assert.equal(result.unknownEffects, undefined);
  assert.equal(result.delivery.delivered, true);
  assert.equal(result.delivery.terminalOutputs, 2);
  assert.equal(result.budgetAttestation.status, "verified");
  assert.equal(result.budgetAttestation.hardLimitsVerified, true);
  assert.equal(result.budgetAttestation.quiescent, true);
  assert.deepEqual(result.budgetAttestation.proofs, g.generated.map((entry) => entry.proof));
  for (const [index, turn] of result.turns.entries()) {
    assert.equal(turn.runId, g.generated[index].params.idempotencyKey);
    assert.equal(turn.sessionId, g.generated[index].session.id);
    assert.equal(turn.nativeSessionId, g.generated[index].binding.sessionId);
    assert.equal(turn.usageBasis, "runtime-provider-attempt-ledger");
    assert.deepEqual(turn.usage, turnUsage);
  }
  assert.equal(g.calls.filter((call) => call.method === "chat.send").length, 2);
  assert.equal(f.children.length, 2);
  assert.equal(f.server.requests.length, 4, "the mismatching turn must stop the third native dispatch");
  const ledger = await readRows(join(context.runDir, "gateway-acceptance-ledger.jsonl"));
  const settlements = ledger.filter((row) => row.event === "turn_settled");
  assert.deepEqual(settlements.map((row) => row.runId), result.turns.map((turn) => turn.runId));
  assert.equal(settlements[0].judgment, undefined);
  assert.equal(settlements[1].judgment.status, "failed");
  assertDiagnosis(settlements[1].judgment.diagnosis);
  assert.equal(ledger.some((row) => row.event === "case_failed"), false);
  await assertAbsent(join(context.runDir, "gateway-admission.lock"));
  const cleanup = await g.adapter.cleanupCase(item, context);
  assert.equal(cleanup.cleaned, true);
  assert.equal(cleanup.quiescent, true);
  assert.equal(g.calls.some((call) => call.method === "chat.abort"), false);
  assert.deepEqual(g.reported, [turnUsage, turnUsage], "cleanup cannot report a settled turn again");

  const independent = task("independent-exact");
  const nextContext = g.context();
  const next = await g.adapter.executeCase(independent, nextContext);
  assert.equal(next.executionStatus, "completed", "a settled body failure must not fence independent cases");
  assert.equal(next.outputText, canonicalText);
  assert.deepEqual(next.usage, turnUsage);
  assert.equal(next.budgetAttestation.status, "verified");
  assert.equal(next.budgetAttestation.quiescent, true);
  assert.notEqual(next.turns[0].sessionId, result.turns[0].sessionId);
  assert.deepEqual(g.reported, [turnUsage, turnUsage, turnUsage]);
  assert.equal(f.children.length, 3);
  assert.equal(f.server.requests.length, 6);
  assert.equal((await g.adapter.cleanupCase(independent, nextContext)).quiescent, true);
  await assertAbsent(join(nextContext.runDir, "gateway-admission.lock"));
  assert.deepEqual(f.serverErrors, []);
});

const mutations = [
  ["missing ledger", async ({ directory }) => rm(join(directory, "operational-budget-ledger.json"))],
  ...["runId", "sessionKey", "agentId"].map((key) => [`foreign ${key}`, async ({ directory }) => {
    const config = await readJson(join(directory, "operational-budget-config.json"));
    const ledger = await readJson(join(directory, "operational-budget-ledger.json"));
    config[key] = `foreign-${randomUUID()}`;
    ledger[key] = config[key];
    ledger.configSha256 = hash(JSON.stringify(config));
    await writeFile(join(directory, "operational-budget-config.json"), JSON.stringify(config));
    await writeFile(join(directory, "operational-budget-ledger.json"), JSON.stringify(ledger));
  }]),
  ["config changes during recovery", async ({ directory, proof }) => {
    const config = await readJson(join(directory, "operational-budget-config.json"));
    const ledger = await readJson(join(directory, "operational-budget-ledger.json"));
    config.maxTokens++;
    ledger.configSha256 = hash(JSON.stringify(config));
    await writeFile(join(directory, "operational-budget-config.json"), JSON.stringify(config));
    await writeFile(join(directory, "operational-budget-ledger.json"), JSON.stringify(ledger));
    const changed = await readRuntimeBudgetProof(directory, { settled: true });
    assert.equal(changed.usageStatus, "complete");
    assert.notEqual(changed.configSha256, proof.configSha256, "a valid but different config cannot replace the pinned proof");
  }, true],
  ["unsettled request", async ({ directory }) => {
    const path = join(directory, "operational-budget-ledger.json");
    const ledger = await readJson(path);
    const lastRequest = ledger.entries.findLast((entry) => entry.type === "request_reserved").requestId;
    ledger.entries = ledger.entries.filter((entry) =>
      entry.type !== "settled" && !(entry.type === "request_settled" && entry.requestId === lastRequest))
      .map((entry, seq) => ({ ...entry, seq }));
    await writeFile(path, JSON.stringify(ledger));
  }],
  ["fenced binding", async ({ directory }) => {
    const path = join(directory, "binding.json");
    const binding = await readJson(path);
    binding.status = "blocked";
    await writeFile(path, JSON.stringify(binding));
  }],
  ["consumed run is not last", async ({ directory }) => {
    const path = join(directory, "binding.json");
    const binding = await readJson(path);
    binding.consumedRunIds.push("another-consumed-run");
    await writeFile(path, JSON.stringify(binding));
  }],
  ["lastRunId changes during recovery", async ({ directory }) => {
    const path = join(directory, "binding.json");
    const binding = await readJson(path);
    binding.lastRunId = "another-run";
    await writeFile(path, JSON.stringify(binding));
  }, true],
  ...["owner.lock", "source-reply.lock"].map((name) => [name, async ({ directory }) => {
    await writeFile(join(directory, name), JSON.stringify({ fixture: "retained ownership" }));
  }, name === "owner.lock"]),
];

test("dist-native LF mismatch cannot recover missing, cross-identity, unsettled or fenced generated evidence",
  { timeout: 600000 }, async (t) => {
    const f = await fixture(t);
    for (const [name, mutate, duringRecovery] of mutations) {
      await t.test(name, async () => {
        let mutationsApplied = 0;
        const applyMutation = async (evidence) => { await mutate(evidence); mutationsApplied++; };
        const g = await f.gateway({ trailingLfAt: [1],
          ...(duringRecovery ? { mutateOnRecovery: applyMutation } : { mutate: applyMutation }) });
        const item = task(`negative-${name}`, ["Say hello.", "This second turn must never run."]);
        const context = g.context();
        const requestsBefore = f.server.requests.length;
        await assert.rejects(g.adapter.executeCase(item, context), (error) => {
          assert.equal(error.evidence.budgetAttestation.status, "unproven");
          assert.equal(error.evidence.budgetAttestation.hardLimitsVerified, false);
          assert.equal(error.evidence.budgetAttestation.quiescent, false);
          assert.equal(error.budgetAccounting.usageStatus, "unknown");
          assert.equal(error.evidence.unknownEffects, true);
          if (name !== "fenced binding") assertDiagnosis(error.diagnosis);
          return true;
        });
        assert.equal(g.generated.length, 1, "every mutation must start from verified real child evidence");
        assert.equal(mutationsApplied, 1, "the mutation must reach its intended settlement boundary");
        assert.equal(g.generated[0].proof.usageStatus, "complete");
        assert.deepEqual(g.reported, [], "unproven settlement must never release usage as complete");
        assert.equal(f.server.requests.length, requestsBefore + 2);
        assert.equal(g.calls.filter((call) => call.method === "chat.send").length, 1);
        assert.ok((await stat(join(context.runDir, "gateway-admission.lock"))).isFile());
        const ledger = await readRows(join(context.runDir, "gateway-acceptance-ledger.jsonl"));
        assert.equal(ledger.filter((row) => row.event === "case_failed").length, 1);
        assert.equal(ledger.some((row) => row.event === "turn_settled"), false);
        const cleanup = await g.adapter.cleanupCase(item, context);
        assert.equal(cleanup.cleaned, false);
        assert.equal(cleanup.quiescent, false);
        assert.equal(g.calls.filter((call) => call.method === "chat.abort").length, 1);
        await assert.rejects(g.adapter.executeCase(task(`after-${name}`), g.context()), /fenced/);
        assert.equal(g.calls.filter((call) => call.method === "chat.send").length, 1);
        assert.ok((await stat(join(context.runDir, "gateway-admission.lock"))).isFile());
      });
    }
    assert.equal(f.children.length, mutations.length);
    assert.equal(f.server.requests.length, mutations.length * 2);
    assert.deepEqual(f.serverErrors, []);
  });
