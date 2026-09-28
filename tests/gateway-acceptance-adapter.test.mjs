import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import { createGatewayAcceptanceAdapter, nativeTurnEvidence, narrowOperationalBudget,
  readRuntimeBudgetProof, resolveConfiguredOperationalBudget, resolveDeadlineAtMs,
  validateOperationalBudget, validateRuntimeBudgetProof, captureBudgetDeadline, remainingDeadlineMs,
  assertBudgetFitsDeadline, preflightConfiguredOperationalBudget } from "../scripts/lib/gateway-acceptance-adapter.mjs";

const root = resolve(process.env.DSH_ACCEPTANCE_TEST_ROOT ?? "artifacts", "gateway-acceptance-adapter-test");
const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const operationalBudget = { maxModelRequests: 4, maxInputTokens: 512, maxOutputTokens: 64,
  maxToolCalls: 4, maxDurationMs: 5000 };
const item = (extra = {}) => ({ id: "unit-case", agentProfile: "scout", prompt: "Read the selected fixture",
  category: "business", limits: { timeoutMs: 2000 }, ...extra });

function nativeRows(name = "read") {
  return [
    { type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1 } },
    { type: "request/header", data: { header: { config: { provider: "github-copilot", model: "gpt-6-astra" } } } },
    { type: "tool/call", data: { turn: 1, callId: "call-1", name, arguments: '{"path":"/fixture.txt"}' } },
    { type: "tool/result", data: { turn: 1, message: { content: [
      { type: "tool-result", toolCallId: "call-1", content: "ok", isError: false },
    ] } } },
    { type: "turn/end", data: { turn: 1 } },
  ];
}

async function fixture(t, { finalText = "ok", tool = "read", dropFinal = false, runtimeBudget = false,
  contextWindow = 128, mutateProof, extraAttempt = false, unsupported = false, onSend,
  configured = false, runtimeCap = operationalBudget, byAgent, missingProof = false, sourceLedger,
  providerUsage = usage, mode = "execute", assistantObservation = {}, finalObservation = {}, extraEvents = [],
  onCreate, onPrepare, onConnect, onHealthy, mutateAdmission, runtimeLedgerClass = sourceLedger, onRuntimeLedger,
  canonicalText = "ok", projectedText, mutateBinding, mutateNativeRows } = {}) {
  const runDir = join(root, randomUUID());
  const nativeStateDir = join(runDir, "native");
  const sessionId = randomUUID();
  const config = { hostRoot: resolve("node_modules", "openclaw"), configPath: join(runDir, "config.json"),
    stateDir: join(runDir, "state"), nativeStateDir, gatewayUrl: "ws://127.0.0.1:18789",
    agentMap: { scout: "agent-a" }, allowedAgentIds: ["agent-a"], ownedSessionPrefix: "acceptance-unit" };
  let activeStateId = sessionId;
  let directory = join(nativeStateDir, hash(activeStateId));
  let assistantKeyPrefix = "dsh-native:";
  let resetCount = 0;
  let nativeSessionId = "native-session";
  await mkdir(directory, { recursive: true });
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const events = [];
  const calls = [];
  const raw = [];
  const completedRuns = new Set();
  const hostConfig = { plugins: { entries: { "dsh-native": { config: { taskPreparation: { skillAllowlist: [] },
    ...(runtimeBudget || configured ? { operationalBudget: runtimeCap } : {}),
    ...(byAgent ? { operationalBudgetByAgent: byAgent } : {}) } } } } };
  let runtimeConfig, runtimeLedger;
  const writeProof = async () => {
    await writeFile(join(directory, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
    await writeFile(join(directory, "operational-budget-ledger.json"), JSON.stringify(runtimeLedger));
  };
  const initializeProof = async (expected) => {
    runtimeConfig = { version: 1, runId: expected.runId, sessionKey: sessionId, agentId: expected.agentId,
      operationalBudget: { ...expected.operationalBudget,
        maxDurationMs: configured ? expected.operationalBudget.maxDurationMs : Math.min(500, expected.operationalBudget.maxDurationMs) }, contextWindow,
      maxTokens: Math.min(32, contextWindow, expected.operationalBudget.maxOutputTokens) };
    runtimeLedger = { version: 1, runId: expected.runId, sessionKey: sessionId, agentId: expected.agentId,
      configSha256: hash(JSON.stringify(runtimeConfig)), entries: [{ seq: 0, type: "admitted", at: Date.now() - 100 }] };
    mutateAdmission?.({ runtimeConfig, ledger: runtimeLedger });
    await writeProof();
    return directory;
  };
  let assistant;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "sessions.create") {
        await onCreate?.();
        return { ok: true, key: params.key, entry: { sessionId, permissionMode: "read-only" } };
      }
      if (method === "chat.send") {
        if (onSend) await onSend(params);
        if (completedRuns.has(params.idempotencyKey)) return { status: "started", runId: params.idempotencyKey };
        if (configured && !missingProof) await initializeProof({ runId: params.idempotencyKey,
          agentId: params.agentId, operationalBudget: resolveConfiguredOperationalBudget(hostConfig, params.agentId) });
        if (runtimeLedgerClass) {
          const ledger = new runtimeLedgerClass(directory, runtimeConfig, "main", Date.now());
          await ledger.initialize();
          if (onRuntimeLedger) await onRuntimeLedger(ledger, directory, runtimeConfig);
          else {
            const request = await ledger.reserve({ maxTokens: runtimeConfig.maxTokens });
            await ledger.settle({ requestId: request.requestId, usage: providerUsage });
            await ledger.startTool("call-1");
            await ledger.settleTool("call-1");
            await ledger.finish();
          }
          await ledger.drain();
        } else if ((configured && !missingProof) || (runtimeBudget && !unsupported)) {
          const append = (entry) => runtimeLedger.entries.push({ seq: runtimeLedger.entries.length,
            at: runtimeLedger.entries[0].at + runtimeLedger.entries.length, ...entry });
          const attempt = (id, purpose, previousOutput = 0) => {
            append({ type: "request_reserved", requestId: id, purpose, inputTokens: contextWindow,
              outputTokens: Math.min(runtimeConfig.maxTokens, runtimeConfig.operationalBudget.maxOutputTokens - previousOutput) });
            append({ type: "request_settled", requestId: id, usage: providerUsage });
          };
          attempt("main", "main");
          for (let index = 0; index < Number(extraAttempt); index++) {
            attempt(index ? `maintenance-${index}` : "maintenance", "compaction", providerUsage.output * (index + 1));
          }
          append({ type: "tool_started", callId: "call-1" });
          append({ type: "tool_settled", callId: "call-1" });
          append({ type: "settled", providerSettled: true, toolsSettled: true });
          mutateProof?.({ runtimeConfig, ledger: runtimeLedger });
          await writeProof();
        }
        assistant = { role: "assistant", content: [{ type: "text", text: canonicalText }],
          idempotencyKey: `${assistantKeyPrefix}${params.idempotencyKey}:assistant`, usage: providerUsage, ...assistantObservation };
        raw.push({ id: randomUUID(), parentId: raw.at(-1)?.id ?? null, type: "message", message: assistant });
        const binding = {
          status: "ready", lastRunId: params.idempotencyKey, sessionId: nativeSessionId,
          consumedRunIds: [...completedRuns, params.idempotencyKey],
          taskPreparation: { state: { mode } },
        };
        mutateBinding?.(binding);
        await writeFile(join(directory, "binding.json"), JSON.stringify(binding));
        for (const event of extraEvents) {
          events.push(typeof event === "function" ? event(params) : event);
        }
        if (!dropFinal) events.push({ event: "chat", payload: { sessionKey: params.sessionKey,
           runId: params.idempotencyKey, state: "final", ...finalObservation,
          message: { ...assistant, content: typeof finalText === "function" ? finalText(params) : finalText } } });
        completedRuns.add(params.idempotencyKey);
        return { status: "started", runId: params.idempotencyKey };
      }
      if (method === "chat.history") return { sessionId,
        messages: [projectedText === undefined ? assistant : { ...assistant, content: projectedText }], inFlightRun: false };
      if (method === "sessions.reset") {
        const resetId = `reset-${++resetCount}`;
        raw.push({ id: resetId, parentId: raw.at(-1)?.id ?? null, type: "reset", context: "clear", reason: params.reason });
        activeStateId = `${sessionId}\0reset\0${resetId}`;
        assistantKeyPrefix = `dsh-native:reset:${resetId}:`;
        nativeSessionId = `native-${resetId}`;
        directory = join(nativeStateDir, hash(activeStateId));
        await mkdir(directory, { recursive: true });
        return { ok: true, key: params.key, entry: { sessionId, permissionMode: "read-only" } };
      }
      if (method === "chat.abort") return { ok: true };
      throw new Error(`Unexpected method ${method}`);
    },
    async stopAndWait() {},
  };
  const adapter = await createGatewayAcceptanceAdapter({
    config, events, readNativeRows: async () => {
      const rows = nativeRows(tool);
      mutateNativeRows?.(rows);
      return rows;
    },
    connectionFactory: async () => { await onConnect?.(); return { client, assertHealthy() { onHealthy?.(); },
      ...(runtimeBudget && !unsupported && !configured ? { prepareOperationalBudget: async (expected) => {
        await onPrepare?.(expected);
        return initializeProof(expected);
      } } : {}),
      hostConfig,
      readTranscript: async () => raw }; },
  });
  const reported = [];
  const context = { runId: randomUUID(), runDir, signal: new AbortController().signal,
    ...(configured ? { operationalBudget: { ...runtimeCap, maxDurationMs: 5000 } } : {}),
    reportUsage: (value) => reported.push(value),
    resources: { modelVisibleContext: "Address: selected file", observations: { hiddenMetadata: "not a prompt" } } };
  return { adapter, context, calls, reported, config, directory, sessionId, hostConfig, events };
}

test("task-only inputs use actual event, canonical and native evidence without double-counting usage", async (t) => {
  const f = await fixture(t);
  const task = item();
  Object.defineProperty(task, "expected", { get() { throw new Error("DUT cannot see oracle"); } });
  const result = await f.adapter.executeCase(task, f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.businessResult, "partial");
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(result.usage.inputTokens, 3);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.budgetAttestation.hardLimitsVerified, false);
  assert.equal(result.budgetAttestation.status, "legacy-unattested");
  assert.deepEqual(f.reported, [result.usage]);
  const sent = f.calls.find((call) => call.method === "chat.send").params;
  assert.equal(sent.metadata, undefined);
  assert.equal(sent.expectedPermissionMode, "read-only");
  assert.equal(f.calls[0].method, "sessions.create");
  assert.match(sent.message, /Address: selected file/);
  assert.doesNotMatch(sent.message, /hiddenMetadata|not a prompt/);
  assert.equal(result.turns[0].prompt, task.prompt);
  assert.equal(result.turns[0].mode, "execute");
  assert.equal(result.turns[0].tools[0].arguments.path, "/fixture.txt");
  assert.equal(result.turns[0].usage.inputTokens, usage.input);
  assert.equal(result.turns[0].delivery.delivered, true);
  assert.equal((await f.adapter.cleanupCase(task, f.context)).cleaned, true);
  assert.match(await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"), /send_planned/);
});

function proofFixture() {
  const runtimeConfig = { version: 1, runId: "run", sessionKey: "session", agentId: "agent",
    operationalBudget, contextWindow: 128, maxTokens: 32 };
  const at = Date.now() - 1000;
  return { runtimeConfig, ledger: { version: 1, runId: "run", sessionKey: "session", agentId: "agent",
    configSha256: hash(JSON.stringify(runtimeConfig)), entries: [
      { seq: 0, type: "admitted", at },
      { seq: 1, type: "request_reserved", at: at + 1, requestId: "req-1", purpose: "main", inputTokens: 128, outputTokens: 32 },
      { seq: 2, type: "request_settled", at: at + 2, requestId: "req-1", usage },
      { seq: 3, type: "settled", at: at + 3, providerSettled: true, toolsSettled: true },
    ] } };
}

test("settled native accounting does not use a later wall-clock reading as a TTL", () => {
  const proof = proofFixture();
  for (const entry of proof.ledger.entries) entry.at += 60000;
  assert.equal(validateRuntimeBudgetProof(proof, { settled: true }).quiescent, true);
  proof.ledger.entries = proof.ledger.entries.slice(0, 1);
  assert.throws(() => validateRuntimeBudgetProof(proof, { settled: false }), /clock identity changed/);
});

test("malformed native tool JSON never leaks parser input into failure diagnostics", async (t) => {
  const secret = "private-parser-input-sentinel";
  const f = await fixture(t, { runtimeBudget: true, mutateNativeRows(rows) {
    rows.find((row) => row.type === "tool/call").data.arguments = secret;
  } });
  await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
    assert.equal(error.message, "Invalid JSON in native evidence");
    assert.ok(!JSON.stringify({ message: error.message, evidence: error.evidence }).includes(secret));
    return true;
  });
  const ledger = await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8");
  assert.ok(!ledger.includes(secret));
  assert.equal(f.reported.length, 0);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

test("runtime host-tool accounting excludes the internal preparation control but preserves its evidence", () => {
  const proof = validateRuntimeBudgetProof(proofFixture(), { settled: true });
  const rows = nativeRows("dsh_prepare_task");
  const result = nativeTurnEvidence(rows, { usage }, proof);
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, "dsh_prepare_task");
  assert.throws(() => nativeTurnEvidence(rows.filter((row) => row.type !== "tool/result"), { usage }, proof),
    /terminal result/);
});

test("internal preparation never exempts a real or similarly named host tool from ledger admission", () => {
  const proof = validateRuntimeBudgetProof(proofFixture(), { settled: true });
  for (const tool of ["read", "write", "dsh_prepare_task_spoof"]) {
    assert.throws(() => nativeTurnEvidence(nativeRows(tool), { usage }, proof), /omitted native tool admissions/);
  }
  const rows = nativeRows("dsh_prepare_task");
  const business = nativeRows("read").filter((row) => ["tool/call", "tool/result"].includes(row.type));
  business[0].data.callId = "business-call";
  business[1].data.message.content[0].toolCallId = "business-call";
  rows.splice(-1, 0, ...business);
  assert.throws(() => nativeTurnEvidence(rows, { usage }, proof), /omitted native tool admissions/);
  const withTool = proofFixture();
  const at = withTool.ledger.entries[0].at;
  withTool.ledger.entries.splice(-1, 1,
    { seq: 3, at: at + 3, type: "tool_started", callId: "business-call" },
    { seq: 4, at: at + 4, type: "tool_settled", callId: "business-call" },
    { seq: 5, at: at + 5, type: "settled", providerSettled: true, toolsSettled: true });
  const result = nativeTurnEvidence(rows, { usage }, validateRuntimeBudgetProof(withTool, { settled: true }));
  assert.equal(result.usage.toolCalls, 1);
  assert.deepEqual(result.calls.map((call) => call.name), ["dsh_prepare_task", "read"]);
});

test("configured prepared Gateway turn settles with zero host-tool ledger admissions", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, tool: "dsh_prepare_task", mode: "draft",
    mutateProof({ ledger }) {
      ledger.entries = ledger.entries.filter((entry) => !["tool_started", "tool_settled"].includes(entry.type))
        .map((entry, seq) => ({ ...entry, seq }));
    } });
  t.after(() => f.adapter.close());
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.budgetAttestation.status, "verified");
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.budgetAttestation.proofs[0].usage.toolCalls, 0);
  assert.deepEqual(result.sideEffects, []);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, true);
});

test("operationalBudget requires exactly all five positive integer root limits", () => {
  for (const field of Object.keys(operationalBudget)) {
    const missing = { ...operationalBudget }; delete missing[field];
    assert.throws(() => validateOperationalBudget(missing), /all five/);
    for (const value of [0, -1, "2", 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateOperationalBudget({ ...operationalBudget, [field]: value }), /all five/);
    }
  }
  assert.throws(() => validateOperationalBudget({ ...operationalBudget, unknown: 1 }), /all five/);
  assert.deepEqual(narrowOperationalBudget(operationalBudget, { inputTokens: 128, outputTokens: 16 }, 1000),
    { ...operationalBudget, maxInputTokens: 128, maxOutputTokens: 16, maxDurationMs: 1000 });
});

test("allocations without configured runtime limits cannot start budgeted Gateway work", async (t) => {
    const f = await fixture(t, { unsupported: true });
    f.context.operationalBudget = operationalBudget;
    const result = await f.adapter.executeCase(item(), f.context);
    assert.equal(result.executionStatus, "infrastructure_blocked");
    assert.equal(result.budgetAttestation.hardLimitsVerified, false);
    assert.equal(result.usage.modelRequests, 0);
    assert.match(result.policyFacts.blockedReason, /proof unsupported/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, true);
});

test("runtime ledger accounts for extra provider maintenance instead of nominal model steps", async (t) => {
  const f = await fixture(t, { runtimeBudget: true, extraAttempt: true });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(result.usage.inputTokens, usage.input * 2);
  assert.equal(result.usage.cacheReadTokens, usage.cacheRead * 2);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.budgetAttestation.hardLimitsVerified, true);
  assert.equal(result.budgetAttestation.contextWindow, 128);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, true);
  assert.deepEqual(f.reported, [result.usage]);
});

const configuredCap = { ...operationalBudget, maxDurationMs: 1000 };

test("absolute deadlines validate numeric bounds and saturate without widening inherited time", () => {
  assert.equal(resolveDeadlineAtMs(1000, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(resolveDeadlineAtMs(1000, 1000, 1500), 1500);
  assert.equal(resolveDeadlineAtMs(1000, 1000, 5000), 2000);
  for (const value of [null, "1000", NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveDeadlineAtMs(1000, 1000, value), /deadlineAtMs/);
  }
});

test("first dispatch counts slow connection and session setup against the original duration", async (t) => {
  for (const setup of ["onConnect", "onCreate"]) {
    await t.test(setup, async (t) => {
      let now = 10000;
      t.mock.method(Date, "now", () => now);
      t.mock.method(performance, "now", () => now);
      const f = await fixture(t, { configured: true, runtimeCap: configuredCap, [setup]: () => { now += 750; } });
      const result = await f.adapter.executeCase(item({ limits: { timeoutMs: 1000 } }), f.context);
      assert.equal(result.executionStatus, "infrastructure_blocked");
      assert.match(result.policyFacts.blockedReason, /maxDurationMs.*remaining/);
      assert.equal(result.budgetAttestation.hardLimitsVerified, false);
      assert.equal(result.usage.modelRequests, 0);
      assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
    });
  }
});

test("inherited deadlines cannot be extended by adapter entry", async (t) => {
  for (const inherited of [10500, 20000]) {
    await t.test(String(inherited), async (t) => {
      let now = 10000;
      t.mock.method(Date, "now", () => now);
      t.mock.method(performance, "now", () => now);
      const f = await fixture(t, { configured: true, runtimeCap: { ...configuredCap, maxDurationMs: 400 },
        onCreate: () => { now += 200; } });
      f.context.deadlineAtMs = inherited;
      const result = await f.adapter.executeCase(item({ limits: { timeoutMs: 500 } }), f.context);
      assert.equal(result.executionStatus, "infrastructure_blocked");
      assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
    });
  }
});

test("subsequent turns retain the original duration after actual first-turn consumption", async (t) => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t, { configured: true, runtimeCap: { ...configuredCap, maxDurationMs: 500 },
    onSend: () => { now += 600; } });
  f.context.operationalBudget = { ...operationalBudget, maxModelRequests: 20,
    maxInputTokens: 2000, maxOutputTokens: 200, maxToolCalls: 20 };
  const result = await f.adapter.executeCase(item({ turns: ["first", "second"], limits: { timeoutMs: 1000 } }), f.context);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.match(result.policyFacts.blockedReason, /maxDurationMs.*remaining/);
  assert.equal(result.turns.length, 1);
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
  assert.equal(result.budgetAttestation.hardLimitsVerified, false);
});

test("equal aggregate and configured durations require operator setup headroom even on the first turn", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap });
  f.context.operationalBudget = configuredCap;
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.match(result.policyFacts.blockedReason, /operator/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
});

test("async preparation cannot dispatch a runtime admission whose duration no longer fits", async (t) => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t, { runtimeBudget: true, onPrepare: () => { now += 750; } });
  await assert.rejects(f.adapter.executeCase(item({ limits: { timeoutMs: 1000 } }), f.context),
    /Configured maxDurationMs.*remaining/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

test("send-boundary recheck rejects a budget that became stale after config checking and ledger awaits", async (t) => {
  let now = 10000;
  let checks = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t, { configured: true, runtimeCap: { ...configuredCap, maxDurationMs: 500 },
    onHealthy: () => { if (++checks === 4) now += 600; } });
  const result = await f.adapter.executeCase(item({ limits: { timeoutMs: 1000 } }), f.context);
  assert.equal(checks, 4);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.match(result.policyFacts.blockedReason, /remaining duration/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
  assert.equal(result.budgetAttestation.hardLimitsVerified, false);
});

test("invalid inherited deadlines fail before setup or chat dispatch", async (t) => {
  let connections = 0;
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, onConnect: () => { connections++; } });
  for (const deadlineAtMs of [null, "1000", NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.adapter.executeCase(item(), { ...f.context, deadlineAtMs }), /deadlineAtMs/);
  }
  const result = await f.adapter.executeCase(item(), { ...f.context, deadlineAtMs: 0 });
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.equal(f.calls.length, 0);
  assert.equal(connections, 0);
});

test("configured Gateway caps admit without a prepare hook and prove the opaque host session identity", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, extraAttempt: true });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(result.budgetAttestation.hardLimitsVerified, true);
  const proof = result.budgetAttestation.proofs[0];
  const sent = f.calls.find((call) => call.method === "chat.send").params;
  assert.equal(proof.sessionKey, f.sessionId);
  assert.notEqual(proof.sessionKey, sent.sessionKey);
  assert.equal(proof.agentId, sent.agentId);
  assert.equal(proof.runId, sent.idempotencyKey);
  assert.equal(sent.operationalBudget, undefined);
  assert.equal(sent.maxTokens, undefined);
  assert.doesNotMatch(sent.message, /maxInputTokens|maxDurationMs|operationalBudget/);
  const log = (await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const admission = log.find((entry) => entry.event === "configured_budget_checked");
  assert.equal(admission.hardLimitsVerified, false);
  assert.equal(admission.budgetStatus, "unproven");
});

test("global and exact-agent configured caps narrow componentwise, never by profile or wildcard", async (t) => {
  const byAgent = { "agent-a": { ...configuredCap, maxModelRequests: 2, maxInputTokens: 256, maxOutputTokens: 100 },
    scout: { ...configuredCap, maxInputTokens: 1 } };
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, byAgent });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.deepEqual(result.budgetAttestation.proofs[0].operationalBudget,
    { ...configuredCap, maxModelRequests: 2, maxInputTokens: 256 });
  const plugin = f.hostConfig.plugins.entries["dsh-native"].config;
  delete plugin.operationalBudget;
  assert.deepEqual(resolveConfiguredOperationalBudget(f.hostConfig, "agent-a"), byAgent["agent-a"]);
  assert.equal(resolveConfiguredOperationalBudget(f.hostConfig, "agent-ab"), undefined);
  plugin.operationalBudgetByAgent["agent-*"] = configuredCap;
  assert.throws(() => resolveConfiguredOperationalBudget(f.hostConfig, "agent-a"), /exact agent/);
});

test("every configured dimension must fit case and campaign remaining caps before dispatch", async (t) => {
  const fields = { maxModelRequests: "modelRequests", maxInputTokens: "inputTokens",
    maxOutputTokens: "outputTokens", maxToolCalls: "toolCalls", maxDurationMs: "timeoutMs" };
  for (const [key, field] of Object.entries(fields)) {
    for (const scope of ["case", "campaign"]) {
      const f = await fixture(t, { configured: true, runtimeCap: configuredCap });
      const task = item();
      if (field === "timeoutMs") {
        if (scope === "case") task.limits.timeoutMs = configuredCap[key] - 1;
        else f.context.timeoutMs = configuredCap[key] - 1;
      } else if (scope === "case") task.limits.usage = { [field]: configuredCap[key] - 1 };
      else f.context.budget = { [field]: configuredCap[key] - 1 };
      const result = await f.adapter.executeCase(task, f.context);
      assert.equal(result.executionStatus, "infrastructure_blocked");
      assert.match(result.policyFacts.blockedReason, /operator must install smaller configured limits/);
      assert.match(result.policyFacts.blockedReason, /full prepared contextWindow/);
      assert.equal(result.budgetAttestation.hardLimitsVerified, false);
      assert.equal(result.usage.modelRequests, 0);
      assert.equal(f.calls.length, 0);
    }
  }
});

test("configured caps block the next turn rather than pretending to narrow after consumption", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap });
  const result = await f.adapter.executeCase(item({ turns: ["first", "second"] }), f.context);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.match(result.policyFacts.blockedReason, /operator/);
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(result.turns.length, 1);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, true);
  assert.equal(result.budgetAttestation.hardLimitsVerified, false);
});

test("multiple configured turns can use a larger case allocation without widening native caps", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap });
  f.context.operationalBudget = Object.fromEntries(Object.entries(configuredCap).map(([key, cap]) => [key, cap * 3]));
  const result = await f.adapter.executeCase(item({ turns: ["first", "second"] }), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.usage.modelRequests, 2);
  assert.deepEqual(result.budgetAttestation.proofs.map((proof) => proof.operationalBudget), [configuredCap, configuredCap]);
});

test("explicit case roots admit repeated native attempts without subtracting earlier turns from the attempt cap", async (t) => {
  const native = { maxModelRequests: 8, maxInputTokens: 2000000, maxOutputTokens: 8000,
    maxToolCalls: 12, maxDurationMs: 90000 };
  const f = await fixture(t, { configured: true, runtimeCap: native, extraAttempt: 2 });
  const root = { maxModelRequests: 24, maxInputTokens: 6000000, maxOutputTokens: 24000,
    maxToolCalls: 36, maxDurationMs: 300000 };
  const admitted = [];
  Object.assign(f.context, { caseBudget: root, attemptBudget: native, operationalBudget: native,
    budget: { inputTokens: 6000000, cacheReadTokens: 6000000, cacheWriteTokens: 6000000 },
    beforeDispatch: (budget) => admitted.push(budget) });
  const result = await f.adapter.executeCase(item({ turns: ["first", "second", "third"],
    limits: { timeoutMs: 300000 } }), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.usage.modelRequests, 9);
  assert.deepEqual(admitted, [native, native, native]);
  assert.deepEqual(result.budgetAttestation.operationalBudget, root);
  assert.deepEqual(result.budgetAttestation.proofs.map((proof) => proof.operationalBudget), admitted);
});

test("aggregate input prevents a second turn even when each separate input/cache field still fits", async (t) => {
  const native = { ...configuredCap, maxInputTokens: 128 };
  const f = await fixture(t, { configured: true, runtimeCap: native,
    providerUsage: { input: 40, cacheRead: 40, cacheWrite: 40, output: 2 } });
  Object.assign(f.context, {
    caseBudget: { ...operationalBudget, maxInputTokens: 240 }, attemptBudget: native,
    budget: { inputTokens: 240, cacheReadTokens: 240, cacheWriteTokens: 240 },
  });
  const result = await f.adapter.executeCase(item({ turns: ["first", "second"] }), f.context);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.equal(result.turns.length, 1);
  assert.equal(result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens, 120);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
});

test("custom native admission stays inside an explicit attempt ceiling even under a larger root", async (t) => {
  const attemptBudget = { ...configuredCap, maxModelRequests: 2, maxInputTokens: 256 };
  const prepared = [];
  const f = await fixture(t, { runtimeBudget: true, onPrepare: (expected) => prepared.push(expected.operationalBudget) });
  Object.assign(f.context, { caseBudget: { ...operationalBudget, maxModelRequests: 16, maxInputTokens: 4096,
    maxOutputTokens: 128, maxToolCalls: 8 },
    attemptBudget });
  const result = await f.adapter.executeCase(item({ turns: ["first", "second"] }), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.deepEqual(prepared, [attemptBudget, attemptBudget]);
  assert.ok(result.budgetAttestation.proofs.every((proof) =>
    proof.operationalBudget.maxModelRequests === 2 && proof.operationalBudget.maxInputTokens === 256));
});

test("runner dispatch rejection stops Gateway model input at the native boundary", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap });
  f.context.beforeDispatch = () => { throw new Error("case pool exhausted"); };
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.match(result.policyFacts.blockedReason, /case pool exhausted/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
});

test("idempotent transport replay reuses its admitted native attempt without authorizing another", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: { ...configuredCap, maxDurationMs: 500 } });
  let admissions = 0;
  f.context.beforeDispatch = () => {
    assert.equal(++admissions, 1, "replay must not request a fresh turn allocation after settlement");
  };
  const result = await f.adapter.executeCase(item({
    adapterControls: [{ type: "duplicate_inbound_delivery", appliesToTurn: 1, visibleToModel: false }],
  }), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(admissions, 1);
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 2);
});

test("captured legacy wall deadlines and dispatch margins use only monotonic elapsed time", (t) => {
  let wall = 10000, monotonic = 1000;
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => monotonic);
  const deadline = captureBudgetDeadline({ timeoutMs: 2000, deadlineAtMs: 11000 });
  assert.equal(deadline.deadlineMonotonicMs, 2000);
  wall = 100;
  monotonic += 600;
  assert.equal(remainingDeadlineMs(deadline), 400);
  assertBudgetFitsDeadline({ maxDurationMs: 375 }, deadline);
  assert.throws(() => assertBudgetFitsDeadline({ maxDurationMs: 376 }, deadline), /remaining duration/);
  wall = 1000000;
  assert.equal(remainingDeadlineMs(deadline), 400);
  monotonic += 401;
  assert.throws(() => assertBudgetFitsDeadline({ maxDurationMs: 1 }, deadline), /remaining duration/);
});

test("backward wall jumps cannot authorize a later Gateway turn after monotonic duration consumption", async (t) => {
  let wall = 10000, monotonic = 1000;
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => monotonic);
  const f = await fixture(t, { configured: true, runtimeCap: { ...configuredCap, maxDurationMs: 500 },
    onSend: () => { monotonic += 600; wall -= 5000; } });
  f.context.caseBudget = { ...operationalBudget, maxModelRequests: 16, maxInputTokens: 4096 };
  f.context.deadlineAtMs = wall + 1000;
  const result = await f.adapter.executeCase(item({ turns: ["first", "second"],
    limits: { timeoutMs: 1000 } }), f.context);
  assert.equal(result.turns.length, 1);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.match(result.policyFacts.blockedReason, /remaining/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
});

test("offline preflight resolves installed exact-agent caps, full context, aggregate cache and headroom", () => {
  const native = { ...configuredCap, maxInputTokens: 128 };
  const hostConfig = { plugins: { entries: { "dsh-native": { config: {
    operationalBudget, operationalBudgetByAgent: { "agent-a": native },
  } } } } };
  const args = { hostConfig, agentId: "agent-a", contextWindow: 128, timeoutMs: 2000,
    caseBudget: { ...operationalBudget, maxInputTokens: 256 }, attemptBudget: native,
    budget: { inputTokens: 256, cacheReadTokens: 256, cacheWriteTokens: 256 },
    used: { inputTokens: 40, cacheReadTokens: 40, cacheWriteTokens: 40, modelRequests: 0,
      outputTokens: 0, toolCalls: 0, userTurns: 0 } };
  assert.deepEqual(preflightConfiguredOperationalBudget(args), native);
  for (const change of [
    { contextWindow: 129 },
    { budget: { ...args.budget, inputTokens: 240 } },
    { attemptBudget: { ...native, maxModelRequests: native.maxModelRequests - 1 } },
    { timeoutMs: native.maxDurationMs },
  ]) assert.throws(() => preflightConfiguredOperationalBudget({ ...args, ...change }));
  assert.throws(() => preflightConfiguredOperationalBudget({ ...args, agentId: "agent-b" }), /Configured/);
  assert.throws(() => preflightConfiguredOperationalBudget({ ...args,
    used: { ...args.used, cacheReadTokens: -1 } }), /Invalid preflight usage/);
});

test("configured admission never attests to missing, mismatched, locked, or fenced post-run proof", async (t) => {
  for (const failure of ["missing", "session", "locked", "fenced"]) {
    const f = await fixture(t, { configured: true, runtimeCap: configuredCap, missingProof: failure === "missing",
      mutateProof({ runtimeConfig, ledger }) {
        if (failure === "session") {
          runtimeConfig.sessionKey = ledger.sessionKey = "agent:agent-a:not-the-host-session";
          ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
        }
        if (failure === "fenced") ledger.entries.at(-1).type = "fenced";
      } });
    if (failure === "locked") await writeFile(join(f.directory, "owner.lock"), "{}");
    await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
      assert.equal(error.budgetAccounting.usageStatus, "unknown");
      assert.deepEqual(error.budgetAccounting.unresolvedExposure, {
        modelRequests: configuredCap.maxModelRequests, inputTokens: configuredCap.maxInputTokens,
        outputTokens: configuredCap.maxOutputTokens, toolCalls: configuredCap.maxToolCalls,
      });
      if (failure === "missing" || failure === "session") {
        assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 0, "unbound attempts are not invented measurements");
        assert.deepEqual(error.budgetAccounting.reserved, {
          modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
        });
      } else assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
      return true;
    });
    assert.deepEqual(f.reported, []);
    assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
    await assert.rejects(f.adapter.executeCase(item({ id: "next" }), f.context), /fenced/);
    assert.match(await readFile(join(f.context.runDir, "gateway-admission.lock"), "utf8"), /admitted/);
  }
});

test("configured native admission reads the actual source ledger and its retained run history", async (t) => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { registerHooks } = await import("node:module");
  const { default: ts } = await import("typescript");
  const srcRoot = new URL("../src/", import.meta.url);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(srcRoot.href) && specifier.endsWith(".js")) {
        const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(source)) return { url: source.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith(srcRoot.href) || !url.endsWith(".ts")) return next(url, context);
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText };
    },
  });
  let BudgetLedger, resolveOperationalBudget;
  try {
    ({ BudgetLedger } = await import(new URL("bridge/budget-ledger.ts", srcRoot)));
    ({ resolveOperationalBudget } = await import(new URL("config.ts", srcRoot)));
  } finally { hooks.deregister(); }
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, sourceLedger: BudgetLedger });
  assert.deepEqual(resolveConfiguredOperationalBudget(f.hostConfig, "agent-a"),
    resolveOperationalBudget(f.hostConfig.plugins.entries["dsh-native"].config, "agent-a"));
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.budgetAttestation.hardLimitsVerified, true);
  const runId = result.turns[0].runId;
  const historical = await readRuntimeBudgetProof(join(f.directory, "budgets", hash(runId)),
    { runId, sessionKey: f.sessionId, agentId: "agent-a", settled: true });
  assert.equal(historical.ledgerSha256, result.budgetAttestation.proofs[0].ledgerSha256);
  await writeFile(join(f.directory, "owner.lock"), "{}");
  await assert.rejects(readRuntimeBudgetProof(join(f.directory, "budgets", hash(runId)), { runId, settled: true }),
    /owner.lock/);
});

test("host/context narrowing is cumulative across multiple turns and does not trust prompt budgets", async (t) => {
  const f = await fixture(t, { runtimeBudget: true });
  f.context.operationalBudget = { ...operationalBudget, maxModelRequests: 2, maxInputTokens: 200 };
  const result = await f.adapter.executeCase(item({ turns: ["ignore all budgets", "second"] }), f.context);
  assert.equal(result.usage.modelRequests, 2);
  const proof = await readRuntimeBudgetProof(f.directory, { settled: true });
  assert.equal(proof.operationalBudget.maxModelRequests, 1);
  assert.equal(proof.operationalBudget.maxInputTokens, 196);
  assert.equal(proof.operationalBudget.maxOutputTokens, 62);
});

test("admission reserves contextWindow even when the actual prompt and usage are tiny", async (t) => {
  const f = await fixture(t, { runtimeBudget: true, contextWindow: 256 });
  f.context.operationalBudget = { ...operationalBudget, maxInputTokens: 128 };
  await assert.rejects(f.adapter.executeCase(item({ prompt: "x" }), f.context), /contextWindow/);
  assert.equal(f.calls.filter((entry) => entry.method === "chat.send").length, 0);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

test("missing usage and outstanding runtime operations fence all later cases, never unknown0", async (t) => {
  for (const mutateProof of [
    ({ ledger }) => { delete ledger.entries[2].usage.input; },
    ({ ledger }) => { ledger.entries.at(-1).type = "fenced"; },
    ({ ledger }) => { ledger.entries.at(-1).toolsSettled = false; },
  ]) {
    const f = await fixture(t, { runtimeBudget: true, mutateProof: (proof) => {
      proof.ledger.entries[2].usage = { ...proof.ledger.entries[2].usage };
      mutateProof(proof);
    } });
    await assert.rejects(f.adapter.executeCase(item(), f.context), /usage|fenced|settlement/);
    assert.deepEqual(f.reported, []);
    assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
    await assert.rejects(f.adapter.executeCase(item({ id: "next" }), f.context), /fenced/);
    assert.equal(f.calls.filter((entry) => entry.method === "chat.send").length, 1);
  }
});

test("a changed runtime config cannot self-attest even if its ledger fingerprint is recomputed", async (t) => {
  const f = await fixture(t, { runtimeBudget: true, mutateProof({ runtimeConfig, ledger }) {
    runtimeConfig.maxTokens = 31;
    ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
  } });
  await assert.rejects(f.adapter.executeCase(item(), f.context), /configuration changed/);
});

test("actual runtime ownership fences prevent quiescence despite canonical final and ready binding", async (t) => {
  const f = await fixture(t, { runtimeBudget: true });
  await writeFile(join(f.directory, "owner.lock"), "{}");
  await assert.rejects(f.adapter.executeCase(item(), f.context), /owner.lock/);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

test("proof requires identity, sequence, immutable configuration and actual terminal settlement", () => {
  const good = proofFixture();
  assert.equal(validateRuntimeBudgetProof(good, { runId: "run", settled: true }).hardLimitsVerified, true);
  for (const mutate of [
    (proof) => { proof.ledger.runId = "other"; },
    (proof) => { proof.ledger.entries[2].seq = 4; },
    (proof) => { proof.ledger.configSha256 = "0".repeat(64); },
    (proof) => { proof.ledger.entries[2].requestId = "other"; },
    (proof) => { proof.ledger.entries.at(-1).providerSettled = false; },
  ]) {
    const proof = structuredClone(good); mutate(proof);
    assert.throws(() => validateRuntimeBudgetProof(proof, { settled: true }));
  }
  assert.throws(() => validateRuntimeBudgetProof(good, { runId: "foreign" }), /identity/);
  assert.throws(() => validateRuntimeBudgetProof(good, { settled: false }), /fresh runtime admission/);
});

test("provider retries require unique context reservations and output is clipped to remaining budget", () => {
  for (const mutate of [
    (proof) => { proof.ledger.entries[1].inputTokens = 1; },
    (proof) => { proof.ledger.entries[1].outputTokens = 65; },
    (proof) => { proof.ledger.entries[2].usage.output = 33; },
    (proof) => { delete proof.ledger.entries[2].usage.cacheWrite; },
  ]) {
    const proof = structuredClone(proofFixture()); mutate(proof);
    assert.throws(() => validateRuntimeBudgetProof(proof));
  }
  const proof = structuredClone(proofFixture());
  const at = proof.ledger.entries[0].at;
  proof.ledger.entries.splice(3, 0,
    { seq: 3, at: at + 3, type: "request_reserved", requestId: "req-1", purpose: "retry", inputTokens: 128, outputTokens: 32 });
  proof.ledger.entries[4].seq = 4;
  proof.ledger.entries[4].at = at + 4;
  assert.throws(() => validateRuntimeBudgetProof(proof), /unique request/);
});

test("pending requests retain their full reservation and unknown usage status after a fence", () => {
  const proof = proofFixture();
  proof.ledger.entries.splice(2, 2, { seq: 2, at: proof.ledger.entries[0].at + 2, type: "fenced" });
  const result = validateRuntimeBudgetProof(proof);
  assert.equal(result.usage, undefined);
  assert.equal(result.observedLowerBound.modelRequests, 1);
  assert.equal(result.usageStatus, "unknown");
  assert.equal(result.hardLimitsVerified, false);
  assert.equal(result.quiescent, false);
});

test("duration deadlines forbid new work but elapsed time alone never proves settlement", () => {
  const proof = proofFixture();
  proof.runtimeConfig.operationalBudget = { ...operationalBudget, maxDurationMs: 2 };
  proof.ledger.configSha256 = hash(JSON.stringify(proof.runtimeConfig));
  assert.equal(validateRuntimeBudgetProof(proof, { settled: true }).hardLimitsVerified, true);
  const pending = structuredClone(proof);
  pending.ledger.entries.splice(2);
  assert.equal(validateRuntimeBudgetProof(pending).quiescent, false);
  assert.throws(() => validateRuntimeBudgetProof(pending, { settled: true }), /unsettled/);
  proof.ledger.entries[1].at += 1;
  assert.throws(() => validateRuntimeBudgetProof(proof), /duration deadline/);
});

test("MAX_SAFE duration uses differences without unsafe admission-time addition", () => {
  const proof = proofFixture();
  proof.runtimeConfig.operationalBudget = { ...operationalBudget, maxDurationMs: Number.MAX_SAFE_INTEGER };
  proof.ledger.configSha256 = hash(JSON.stringify(proof.runtimeConfig));
  assert.equal(validateRuntimeBudgetProof(proof, { settled: true }).hardLimitsVerified, true);
  proof.ledger.entries.splice(1);
  assert.equal(validateRuntimeBudgetProof(proof, { settled: false }).status, "admitted");
});

test("parallel input reservations cannot overbook the remaining input pool", () => {
  const proof = proofFixture();
  proof.runtimeConfig.operationalBudget = { ...operationalBudget, maxInputTokens: 200 };
  proof.ledger.configSha256 = hash(JSON.stringify(proof.runtimeConfig));
  proof.ledger.entries[2] = { ...proof.ledger.entries[1], seq: 2, requestId: "parallel", at: proof.ledger.entries[0].at + 2 };
  assert.throws(() => validateRuntimeBudgetProof(proof), /contextWindow reservation/);
});

test("failed settlement proof retains measured lower bounds and unreleased reservations", () => {
  for (const pending of [false, true]) {
    const proof = proofFixture();
    if (pending) proof.ledger.entries.splice(2, 1);
    proof.ledger.entries.at(-1).type = "fenced";
    proof.ledger.entries.forEach((entry, seq) => { entry.seq = seq; });
    assert.throws(() => validateRuntimeBudgetProof(proof, { settled: true }), (error) => {
      assert.equal(error.budgetAccounting.usageStatus, "unknown");
      assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
      assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, pending ? 0 : 3);
      assert.equal(error.budgetAccounting.reserved.inputTokens, pending ? 128 : 0);
      return true;
    });
  }
});

test("a later fenced turn retains earlier measured consumption without counting reservations as usage", async (t) => {
  let count = 0;
  const f = await fixture(t, { runtimeBudget: true, mutateProof({ ledger }) {
    if (++count === 2) ledger.entries.at(-1).type = "fenced";
  } });
  await assert.rejects(f.adapter.executeCase(item({ turns: ["first", "second"] }), f.context), (error) => {
    assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 2);
    assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, 6);
    assert.equal(error.budgetAccounting.reserved.inputTokens, 0);
    return true;
  });
  assert.equal(f.reported.length, 1);
  assert.match(await readFile(join(f.context.runDir, "gateway-admission.lock"), "utf8"), /admitted/);
  const restarted = await createGatewayAcceptanceAdapter({ config: f.config,
    connectionFactory: async () => ({ hostConfig: {}, assertHealthy() {}, client: {
      request() { throw new Error("must not send after durable fence"); },
    } }) });
  await assert.rejects(restarted.executeCase(item({ id: "after-restart" }), f.context), /EEXIST/);
});

test("Gateway admission is exclusive even before asynchronous connection/marker work settles", async (t) => {
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { onSend: () => paused });
  const first = f.adapter.executeCase(item(), f.context);
  await assert.rejects(f.adapter.executeCase(item({ id: "parallel" }), f.context), /active/);
  release();
  await first;
});

test("compiled multi-turn strings remain distinct, rather than repeating the first prompt", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ turns: ["First request", "Second request"] }), f.context);
  assert.deepEqual(result.turns.map((turn) => turn.prompt), ["First request", "Second request"]);
  assert.equal(result.usage.userTurns, 2);
});

test("legacy duplicate inbound delivery remains a current-turn idempotency replay", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ turns: ["First request", "Second request"],
    adapterControls: [{ type: "duplicate_inbound_delivery", appliesToTurn: 2, visibleToModel: false }] }), f.context);
  const sends = f.calls.filter((call) => call.method === "chat.send").map((call) => call.params);
  assert.equal(sends.length, 3);
  assert.match(sends[1].message, /Second request/);
  assert.doesNotMatch(sends[1].message, /First request/);
  assert.equal(sends[2].message, sends[1].message);
  assert.equal(sends[2].idempotencyKey, sends[1].idempotencyKey);
  assert.deepEqual(result.turns.map((turn) => turn.prompt), ["First request", "Second request"]);
  assert.equal(result.controlReceipts[0].replaySourceTurn, undefined);
});

test("versioned duplicate inbound delivery can replay captured earlier prompt bytes without exposing control text", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ turns: ["Captured A/B payload", "ADAPTER CONTROL TEXT MUST NOT REACH MODEL"],
    adapterControls: [{ type: "duplicate_inbound_delivery", appliesToTurn: 2, visibleToModel: false,
      controlVersion: 1, replaySourceTurn: 1 }] }), f.context);
  const sends = f.calls.filter((call) => call.method === "chat.send").map((call) => call.params);
  assert.equal(sends.length, 3);
  assert.match(sends[1].message, /Captured A\/B payload/);
  assert.doesNotMatch(sends[1].message, /ADAPTER CONTROL TEXT/);
  assert.equal(sends[2].message, sends[1].message);
  assert.equal(sends[2].idempotencyKey, sends[1].idempotencyKey);
  assert.deepEqual(result.turns.map((turn) => turn.prompt), ["Captured A/B payload", "Captured A/B payload"]);
  const receipt = result.controlReceipts[0];
  assert.equal(receipt.controlVersion, 1);
  assert.equal(receipt.replaySourceTurn, 1);
  assert.equal(receipt.sourceReceiptId, result.turns[0].runId);
  assert.equal(receipt.sourcePromptSha256, hash("Captured A/B payload"));
  assert.equal(receipt.dispatchedPromptSha256, hash("Captured A/B payload"));
  assert.equal(receipt.targetManifestPromptSha256, hash("ADAPTER CONTROL TEXT MUST NOT REACH MODEL"));
});

test("legacy current-turn duplication after reset remains valid regardless of control ordering", async (t) => {
  for (const reverse of [false, true]) {
    const f = await fixture(t);
    const controls = [
      { type: "new_context", appliesAfterTurn: 1, visibleToModel: false },
      { type: "duplicate_inbound_delivery", appliesToTurn: 2, visibleToModel: false },
    ];
    const result = await f.adapter.executeCase(item({ turns: ["source", "new request after reset"],
      adapterControls: reverse ? controls.reverse() : controls }), f.context);
    const sends = f.calls.filter((call) => call.method === "chat.send").map((call) => call.params);
    assert.equal(result.executionStatus, "completed");
    assert.equal(sends.length, 3);
    assert.equal(sends[1].message, `new request after reset\n\n${f.context.resources.modelVisibleContext}`);
    assert.deepEqual(sends[2], sends[1]);
    assert.notEqual(result.turns[0].nativeSessionId, result.turns[1].nativeSessionId);
  }
});

test("captured replay retains exact original resource-context bytes", async (t) => {
  let context;
  let sendsObserved = 0;
  const f = await fixture(t, { onSend() {
    if (++sendsObserved === 1) context.resources.modelVisibleContext = "changed reference after capture";
  } });
  context = f.context;
  f.context.resources = { modelVisibleContext: "resource reference at capture" };
  const result = await f.adapter.executeCase(item({ turns: ["Captured payload", "CONTROL CARRIER"],
    adapterControls: [{ type: "duplicate_inbound_delivery", appliesToTurn: 2, visibleToModel: false,
      controlVersion: 1, replaySourceTurn: 1 }] }), f.context);
  const sends = f.calls.filter((call) => call.method === "chat.send").map((call) => call.params);
  assert.equal(sends[0].message, "Captured payload\n\nresource reference at capture");
  assert.equal(sends[1].message, sends[0].message);
  assert.deepEqual(sends[2], sends[1]);
  const receipt = result.controlReceipts[0];
  assert.equal(receipt.sourceMessageSha256, hash(sends[0].message));
  assert.equal(receipt.dispatchedMessageSha256, receipt.sourceMessageSha256);
});

test("versioned replay can cross an explicit reset using captured adapter-owned bytes", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ turns: ["Captured before reset", "CONTROL CARRIER AFTER RESET"],
    adapterControls: [
      { type: "new_context", appliesAfterTurn: 1, visibleToModel: false },
      { type: "duplicate_inbound_delivery", appliesToTurn: 2, visibleToModel: false,
        controlVersion: 1, replaySourceTurn: 1 },
    ] }), f.context);
  const sends = f.calls.filter((call) => call.method === "chat.send").map((call) => call.params);
  assert.equal(sends.length, 3);
  assert.match(sends[1].message, /Captured before reset/);
  assert.doesNotMatch(sends[1].message, /CONTROL CARRIER/);
  assert.notEqual(result.turns[0].nativeSessionId, result.turns[1].nativeSessionId);
  assert.equal(result.controlReceipts.find((receipt) => receipt.type === "new_context").transportControlled, true);
  const replay = result.controlReceipts.find((receipt) => receipt.type === "duplicate_inbound_delivery");
  assert.equal(replay.replayCrossesReset, true);
  assert.equal(replay.replaySourceTurn, 1);
});

test("turn objects preserve raw prompts and optional observed submission IDs", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ turns: [
    { prompt: "First request", submissionId: "turn-1" },
    { prompt: "Second request" },
  ] }), f.context);
  assert.deepEqual(result.turns.map((turn) => turn.prompt), ["First request", "Second request"]);
  assert.equal(result.turns[0].submissionId, "turn-1");
  assert.equal(result.turns[1].submissionId, undefined);
});

test("campaign input budgets count cache tokens before admitting another turn", async (t) => {
  const f = await fixture(t, { runtimeBudget: true, contextWindow: 1, providerUsage: { input: 0, output: 1, cacheRead: 1, cacheWrite: 0 } });
  f.context.operationalBudget = { ...operationalBudget, maxModelRequests: 4, maxInputTokens: 32, maxOutputTokens: 4 };
  f.context.budget = { inputTokens: 1 };
  const result = await f.adapter.executeCase(item({ turns: ["First request", "Second request"] }), f.context);
  assert.equal(result.executionStatus, "infrastructure_blocked");
  assert.equal(result.turns.length, 1);
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(result.usage.outputTokens, 1, "output budget remains, so only cached input prevents the second turn");
  assert.equal(result.usage.cacheReadTokens, 1);
  assert.match(result.policyFacts.blockedReason, /operator|allocation|contextWindow/);
});

test("foreign agents and actual channel requirements block without a send or business success", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.adapter.executeCase(item({ agentProfile: "foreign" }), f.context)).executionStatus, "infrastructure_blocked");
  assert.equal((await f.adapter.executeCase(item({ category: "delivery" }), f.context)).executionStatus, "infrastructure_blocked");
  assert.equal(f.calls.length, 0);
});

test("durable consumed-case marker prevents a repeated submission", async (t) => {
  const f = await fixture(t);
  await f.adapter.executeCase(item(), f.context);
  await assert.rejects(f.adapter.executeCase(item(), f.context), /EEXIST/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
});

test("history cannot substitute for a missing live final", async (t) => {
  const f = await fixture(t, { dropFinal: true });
  const task = item({ limits: { timeoutMs: 100 } });
  await assert.rejects(f.adapter.executeCase(task, f.context), /actual chat.final|duration expired/);
  assert.equal((await f.adapter.cleanupCase(task, f.context)).cleaned, false);
  assert.ok(f.calls.some((call) => call.method === "chat.abort"));
});

test("live final/history disagreement remains failed and cannot produce a clean receipt", async (t) => {
  const f = await fixture(t, { finalText: "wrong" });
  await assert.rejects(f.adapter.executeCase(item(), f.context), /differs from committed/);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).cleaned, false);
});

test("settled exact-body mismatches retain failure, private diagnostics and once-only accounting", async (t) => {
  const canonical = "PRIVATE-output-中🧪";
  for (const suffix of ["\n", "\r\n", "\t", " ", "\n\n"]) {
    await t.test(JSON.stringify(suffix), async (t) => {
      const f = await fixture(t, { runtimeBudget: true, canonicalText: canonical, finalText: canonical + suffix });
      const result = await f.adapter.executeCase(item(), f.context);
      assert.equal(result.executionStatus, "failed");
      assert.equal(result.businessResult, "failed");
      assert.equal(result.outputText, canonical + suffix, "keep exact delivered bytes; do not trim or replace with canonical");
      assert.equal(result.usage.modelRequests, 1);
      assert.equal(result.budgetAttestation.status, "verified");
      assert.equal(result.budgetAttestation.quiescent, true);
      assert.deepEqual(f.reported, [result.usage]);
      assert.equal(result.diagnosis.firstDiffUtf8Byte, Buffer.byteLength(canonical));
      assert.equal(result.diagnosis.actual.utf8Bytes, Buffer.byteLength(canonical + suffix));
      assert.equal(result.diagnosis.canonical.sha256, hash(canonical));
      assert.equal(result.diagnosis.actual.whitespace.trailingUtf8Bytes, Buffer.byteLength(suffix));
      assert.doesNotMatch(JSON.stringify({ error: result.error, diagnosis: result.diagnosis }), /PRIVATE-output|中|🧪/u);
      const rows = (await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"))
        .trim().split("\n").map(JSON.parse);
      assert.equal(rows.at(-1).event, "turn_settled");
      assert.deepEqual(rows.at(-1).judgment, { status: "failed", diagnosis: result.diagnosis });
      assert.doesNotMatch(JSON.stringify(rows), /PRIVATE-output|中|🧪/u);
      assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, true);
      await assert.rejects(readFile(join(f.context.runDir, "gateway-admission.lock")), { code: "ENOENT" });
      const next = await f.adapter.executeCase(item({ id: `independent-${randomUUID()}` }), f.context);
      assert.equal(next.businessResult, "failed", "independent work runs without promoting the mismatch");
      assert.equal(f.reported.length, 2);
    });
  }
});

test("projection mismatch is a body failure, not missing provider accounting", async (t) => {
  const f = await fixture(t, { runtimeBudget: true, projectedText: "ok\n" });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.diagnosis.code, "GATEWAY_PROJECTED_CANONICAL_MISMATCH");
  assert.equal(result.businessResult, "failed");
  assert.equal(result.budgetAttestation.status, "verified");
  assert.equal(f.reported.length, 1);
});

test("body recovery requires independently known original execution and preparation semantics", async (t) => {
  for (const [surface, body] of [
    ["final", { finalText: "ok\n" }],
    ["projection", { projectedText: "ok\n" }],
  ]) {
    const unknowns = [
      ...["unknown", undefined, null, "future-status"].map((executionStatus) => [
        `execution-${String(executionStatus)}`, { assistantObservation: { executionStatus } }, executionStatus, "execute",
      ]),
      ["unknown-stop", { assistantObservation: { executionStatus: "completed", stopReason: "unexpected" } }, "unknown", "execute"],
      ["conflicting-raw-status", { assistantObservation: { executionStatus: "failed" },
        finalObservation: { executionStatus: "unknown" } }, "unknown", "execute"],
      ...["unknown", null, ""].flatMap((mode) => ["completed", "failed"].map((executionStatus) => [
        `mode-${String(mode)}-${executionStatus}`, { mode, assistantObservation: { executionStatus } }, executionStatus, mode,
      ])),
      ["missing-mode", { assistantObservation: { executionStatus: "completed" },
        mutateBinding: (binding) => { delete binding.taskPreparation; } }, "completed", undefined],
    ];
    for (const [name, options, executionStatus, mode] of unknowns) {
      await t.test(`${surface}-${name}`, async (t) => {
        const f = await fixture(t, { runtimeBudget: true, ...body, ...options });
        const task = item({ turns: ["first", "must remain fenced"] });
        await assert.rejects(f.adapter.executeCase(task, f.context), (error) => {
          assert.equal(error.code, surface === "final" ?
            "GATEWAY_FINAL_CANONICAL_MISMATCH" : "GATEWAY_PROJECTED_CANONICAL_MISMATCH");
          assert.equal(error.evidence.turns.length, 1);
          assert.equal(error.evidence.turns[0].executionStatus, executionStatus);
          assert.equal(error.evidence.turns[0].mode, mode);
          assert.equal(error.evidence.turns[0].outputSha256, hash(surface === "final" ? "ok\n" : "ok"));
          assert.equal(error.evidence.turns[0].usage.modelRequests, 1);
          assert.equal(error.evidence.budgetAttestation.status, "unproven");
          assert.equal(error.evidence.budgetAttestation.quiescent, false);
          assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
          assert.equal(error.budgetAccounting.unresolvedExposure.inputTokens > 0, true);
          return true;
        });
        assert.deepEqual(f.reported, []);
        const rows = (await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"))
          .trim().split("\n").map(JSON.parse);
        assert.equal(rows.at(-1).event, "case_failed");
        assert.equal(rows.some((row) => row.event === "turn_settled"), false);
        assert.ok(await readFile(join(f.context.runDir, "gateway-admission.lock")));
        const cleanup = await f.adapter.cleanupCase(task, f.context);
        assert.equal(cleanup.cleaned, false);
        assert.equal(cleanup.quiescent, false);
        await assert.rejects(f.adapter.executeCase(item({ id: "next" }), f.context), /fenced/);
        assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
      });
    }
  }
});

test("known execution statuses and preparation modes still settle body-only failures", async (t) => {
  for (const mode of ["chat", "clarify", "draft", "execute"]) {
    for (const executionStatus of ["completed", "correctly_blocked", "failed", "infrastructure_blocked"]) {
      await t.test(`${mode}-${executionStatus}`, async (t) => {
        const f = await fixture(t, { runtimeBudget: true, finalText: "ok\n", mode,
          assistantObservation: { executionStatus } });
        const result = await f.adapter.executeCase(item(), f.context);
        assert.equal(result.executionStatus, "failed");
        assert.equal(result.businessResult, "failed");
        assert.equal(result.turns[0].mode, mode);
        assert.equal(result.budgetAttestation.status, "verified");
        assert.equal(result.budgetAttestation.quiescent, true);
        assert.equal(result.usage.modelRequests, 1);
        assert.deepEqual(f.reported, [result.usage]);
        const cleanup = await f.adapter.cleanupCase(item(), f.context);
        assert.equal(cleanup.cleaned, true);
        assert.equal(cleanup.quiescent, true);
        await assert.rejects(readFile(join(f.context.runDir, "gateway-admission.lock")), { code: "ENOENT" });
      });
    }
  }
});

test("success followed by a settled mismatched turn never double-reports or admits a third turn", async (t) => {
  let sends = 0;
  const f = await fixture(t, { runtimeBudget: true, finalText: () => ++sends === 1 ? "ok" : "ok\n" });
  const result = await f.adapter.executeCase(item({ turns: ["first", "second", "must not send"] }), f.context);
  assert.equal(result.turns.length, 2);
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(result.usage.inputTokens, 6);
  assert.equal(result.usage.userTurns, 2);
  assert.equal(result.budgetAttestation.proofs.length, 2);
  assert.equal(f.reported.length, 2);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 2);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, true);
});

test("mismatch proof gaps and fenced bindings cannot be converted to complete accounting", async (t) => {
  for (const [name, options] of [
    ["no proof", { configured: true, runtimeCap: configuredCap, missingProof: true }],
    ["foreign run", { runtimeBudget: true, mutateProof: ({ runtimeConfig, ledger }) => {
      runtimeConfig.runId = ledger.runId = "other"; ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
    } }],
    ["foreign session", { runtimeBudget: true, mutateProof: ({ runtimeConfig, ledger }) => {
      runtimeConfig.sessionKey = ledger.sessionKey = "other"; ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
    } }],
    ["foreign agent", { runtimeBudget: true, mutateProof: ({ runtimeConfig, ledger }) => {
      runtimeConfig.agentId = ledger.agentId = "other"; ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
    } }],
    ["pending", { runtimeBudget: true, mutateProof: ({ ledger }) => ledger.entries.splice(2) }],
    ["fenced binding", { runtimeBudget: true, mutateBinding: (binding) => { binding.budgetFailure = {}; } }],
    ["unconsumed binding", { runtimeBudget: true, mutateBinding: (binding) => { delete binding.consumedRunIds; } }],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { ...options, finalText: "ok\n" });
      await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
        assert.equal(error.budgetAccounting.usageStatus, "unknown");
        assert.equal(error.evidence.budgetAttestation.status, "unproven");
        assert.equal(error.budgetAccounting.unresolvedExposure.inputTokens > 0, true);
        if (name !== "fenced binding") assert.match(error.message, /differs from committed/);
        return true;
      });
      assert.equal(f.reported.length, 0);
      assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
    });
  }
});

test("a usage callback that throws after recording cannot be retried by mismatch recovery", async (t) => {
  const f = await fixture(t, { runtimeBudget: true, finalText: "ok\n" });
  const report = f.context.reportUsage;
  f.context.reportUsage = (value) => { report(value); throw new Error("accounting callback failed"); };
  await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
    assert.match(error.message, /differs from committed/);
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    return true;
  });
  assert.equal(f.reported.length, 1);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

test("late owned terminal events invalidate mismatch recovery without a second usage callback", async (t) => {
  for (const state of ["aborted", "error", "final"]) {
    await t.test(state, async (t) => {
      const f = await fixture(t, { runtimeBudget: true, finalText: "ok\n" });
      const report = f.context.reportUsage;
      f.context.reportUsage = (value) => {
        report(value);
        const final = f.events.find((frame) => frame.payload.state === "final");
        f.events.push({ event: "chat", payload: { ...final.payload, state } });
      };
      await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
        assert.match(error.message, /differs from committed/);
        assert.equal(error.budgetAccounting.usageStatus, "unknown");
        assert.equal(error.budgetAccounting.unresolvedExposure.inputTokens > 0, true);
        return true;
      });
      assert.equal(f.reported.length, 1);
      assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
      await assert.rejects(f.adapter.executeCase(item({ id: "after-late-frame" }), f.context), /fenced/);
    });
  }
});

test("unrecoverable mismatch errors contain fingerprints rather than private turn bodies", async (t) => {
  const secret = "PRIVATE-output-token-中🧪";
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, missingProof: true,
    canonicalText: secret, finalText: `${secret}\n` });
  await assert.rejects(f.adapter.executeCase(item({ prompt: "PRIVATE-prompt-do-not-log" }), f.context), (error) => {
    assert.equal(error.code, "GATEWAY_FINAL_CANONICAL_MISMATCH");
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    assert.doesNotMatch(inspect(error, { depth: null }), /PRIVATE-output|PRIVATE-prompt|中|🧪/u);
    assert.equal(error.evidence.turns[0].outputSha256, hash(`${secret}\n`));
    return true;
  });
  const ledger = await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /PRIVATE-output|PRIVATE-prompt|中|🧪/u);
});

test("explicit raw failed and infrastructure statuses are never promoted by native mode", async (t) => {
  for (const executionStatus of ["failed", "infrastructure_blocked"]) {
    const f = await fixture(t, { assistantObservation: { executionStatus }, mode: "clarify" });
    const task = item({ turns: ["Original prompt", "Must not overwrite the first failure"] });
    Object.defineProperty(task, "expected", { get() { throw new Error("DUT cannot see oracle"); } });
    const result = await f.adapter.executeCase(task, f.context);
    assert.equal(result.executionStatus, executionStatus);
    assert.equal(result.businessResult, "failed");
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].executionStatus, executionStatus);
    assert.equal(result.turns[0].mode, "clarify");
    assert.equal(result.turns[0].prompt, "Original prompt");
    assert.equal(result.turns[0].tools[0].name, "read");
    assert.equal(result.turns[0].usage.modelRequests, 1);
    assert.equal(result.turns[0].delivery.delivered, true);
    assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
  }
});

test("abnormal raw stop reasons are not inferred as semantic completion", async (t) => {
  for (const stopReason of ["error", "aborted"]) {
    const f = await fixture(t, { assistantObservation: { stopReason, executionStatus: "completed" } });
    const result = await f.adapter.executeCase(item(), f.context);
    assert.equal(result.executionStatus, "failed");
    assert.equal(result.businessResult, "failed");
  }
});

test("exact bodies cannot release unknown execution or preparation semantics either", async (t) => {
  for (const [name, options, executionStatus] of [
    ...["unknown", undefined, null].map((executionStatus) => [
      `execution-${String(executionStatus)}`, { assistantObservation: { executionStatus } }, executionStatus,
    ]),
    ["stop", { assistantObservation: { stopReason: "unexpected", executionStatus: "completed" } }, "unknown"],
    ["mode", { mode: "unknown", assistantObservation: { executionStatus: "completed" } }, "completed"],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { runtimeBudget: true, ...options });
      await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
        assert.equal(error.evidence.turns[0].executionStatus, executionStatus);
        assert.equal(error.evidence.budgetAttestation.quiescent, false);
        assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
        assert.ok(error.budgetAccounting.unresolvedExposure.inputTokens > 0);
        return true;
      });
      assert.deepEqual(f.reported, []);
      const rows = (await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"))
        .trim().split("\n").map(JSON.parse);
      assert.equal(rows.some((row) => row.event === "turn_settled"), false);
      assert.equal((await f.adapter.cleanupCase(item(), f.context)).cleaned, false);
      await assert.rejects(f.adapter.executeCase(item({ id: "next" }), f.context), /fenced/);
    });
  }
});

test("configured runtime proof cannot substitute rewritten caps with a matching new ledger hash", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, mutateProof({ runtimeConfig, ledger }) {
    runtimeConfig.operationalBudget.maxToolCalls--;
    ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
  } });
  await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
    assert.match(error.message, /differs from the pinned configured limits/);
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
    return true;
  });
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

test("raw preparation calls remain in the turn trace instead of being silently filtered", async (t) => {
  const f = await fixture(t, { tool: "dsh_prepare_task", mode: "draft" });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.turns[0].tools.length, 1);
  assert.equal(result.turns[0].tools[0].name, "dsh_prepare_task");
  assert.equal(result.turns[0].tools[0].result, "ok");
  assert.equal(result.turns[0].usage.toolCalls, 1);
  assert.deepEqual(result.sideEffects, []);
});

test("unclassified exec effects stop further campaign work", async (t) => {
  const f = await fixture(t, { tool: "exec" });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.unknownEffects, true);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).cleaned, false);
});

test("fallback lifecycle events fail closed instead of certifying enforced-mode work", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, extraAttempt: true, extraEvents: [
    ({ sessionKey, idempotencyKey }) => ({
      event: "agent",
      payload: { sessionKey, runId: idempotencyKey, stream: "lifecycle", data: { phase: "fallback", error: "unsafe" } },
    }),
  ] });
  await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
    assert.match(error.message, /fallback|Owned Gateway turn failed/);
    assert.equal(error.evidence.executionStatus, "infrastructure_blocked");
    assert.equal(error.evidence.turns[0].prompt, undefined, "errors must not retain prompt contents");
    assert.equal(error.evidence.turns[0].executionStatus, "infrastructure_blocked");
    assert.equal(error.evidence.turns[0].terminalEvent.payload.data.phase, "fallback");
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 2);
    assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, usage.input * 2);
    return true;
  });
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).cleaned, false);
  const rows = (await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-2).evidence.turns[0].executionStatus, "infrastructure_blocked");
});

test("post-dispatch failure without journal retains full unresolved exposure rather than fabricated reservations", async (t) => {
  const f = await fixture(t, { configured: true, runtimeCap: configuredCap, missingProof: true, extraEvents: [
    ({ sessionKey, idempotencyKey }) => ({ event: "chat", payload: { sessionKey, runId: idempotencyKey,
      state: "error", errorMessage: "Synthetic provider failure" } }),
  ] });
  await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
    assert.equal(error.evidence.turns[0].executionStatus, "failed");
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    assert.deepEqual(error.budgetAccounting.reserved, { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 });
    assert.deepEqual(error.budgetAccounting.unresolvedExposure, {
      modelRequests: configuredCap.maxModelRequests, inputTokens: configuredCap.maxInputTokens,
      outputTokens: configuredCap.maxOutputTokens, toolCalls: configuredCap.maxToolCalls,
    });
    return true;
  });
  assert.deepEqual(f.reported, []);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
});

const noReservations = { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
const exposureOf = (budget) => ({ modelRequests: budget.maxModelRequests, inputTokens: budget.maxInputTokens,
  outputTokens: budget.maxOutputTokens, toolCalls: budget.maxToolCalls });

test("dist Gateway journals keep unresolved exposure separate from admission, partial usage and reservations", async (t) => {
  const { BudgetLedger } = await import("../dist/bridge/budget-ledger.js");
  for (const mode of ["admission only", "pending", "active measured", "partial measured", "malformed", "invalid JSON",
    "fenced", "owner lock", "source reply lock", "config identity", "config caps", "settled",
    "provider timeout", "provider abort"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { configured: true, runtimeCap: configuredCap, runtimeLedgerClass: BudgetLedger,
        extraEvents: [({ sessionKey, idempotencyKey }) => ({ event: "chat", payload: {
          sessionKey, runId: idempotencyKey, state: "error", errorMessage: mode.startsWith("provider ") ?
            mode : "Synthetic post-dispatch failure",
        } })],
        async onRuntimeLedger(ledger, directory, runtimeConfig) {
          if (mode === "admission only") return;
          const request = await ledger.reserve({ maxTokens: 32 });
          if (mode !== "pending") await ledger.settle({ requestId: request.requestId, usage });
          if (mode === "active measured" || mode === "pending") return;
          if (mode === "partial measured") await ledger.reserve({ maxTokens: 32 });
          else if (mode === "fenced") { await ledger.fence(); return; }
          else await ledger.finish();
          if (["malformed", "partial measured"].includes(mode)) {
            const path = join(directory, "operational-budget-ledger.json");
            const journal = JSON.parse(await readFile(path, "utf8"));
            journal.entries.push({ type: "invalid-event", seq: journal.entries.length, at: Date.now() });
            await writeFile(path, JSON.stringify(journal));
          }
          if (mode === "invalid JSON") await writeFile(join(directory, "operational-budget-ledger.json"), "{");
          if (mode.endsWith("lock")) {
            await writeFile(join(directory, mode === "owner lock" ? "owner.lock" : "source-reply.lock"), "{}");
          }
          if (mode.startsWith("config ")) {
            if (mode === "config identity") runtimeConfig.runId = "foreign";
            else runtimeConfig.operationalBudget.maxToolCalls--;
            const path = join(directory, "operational-budget-ledger.json");
            const journal = JSON.parse(await readFile(path, "utf8"));
            journal.runId = runtimeConfig.runId;
            journal.configSha256 = hash(JSON.stringify(runtimeConfig));
            await writeFile(join(directory, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
            await writeFile(path, JSON.stringify(journal));
          }
        },
      });
      await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
        const accounting = error.budgetAccounting;
        const untrusted = ["config identity", "invalid JSON"].includes(mode);
        const measured = !untrusted && !["admission only", "pending"].includes(mode);
        assert.equal(accounting.usageStatus, "unknown");
        assert.equal(accounting.observedLowerBound.modelRequests,
          mode === "partial measured" ? 2 : measured || mode === "pending" ? 1 : 0);
        assert.equal(accounting.observedLowerBound.inputTokens, measured ? usage.input : 0);
        assert.equal(accounting.observedLowerBound.cacheReadTokens, measured ? usage.cacheRead : 0);
        assert.deepEqual(accounting.reserved, ["pending", "partial measured"].includes(mode) ?
          { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 } : noReservations);
        assert.deepEqual(accounting.unresolvedExposure, mode === "settled" ? noReservations : exposureOf(configuredCap));
        assert.deepEqual(error.evidence.budgetAccounting, accounting);
        return true;
      });
      assert.deepEqual(f.reported, []);
      assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
      assert.equal((await f.adapter.cleanupCase(item(), f.context)).quiescent, false);
      await assert.rejects(f.adapter.executeCase(item({ id: "no-fallback" }), f.context), /fenced/);
      const rows = (await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"))
        .trim().split("\n").map(JSON.parse);
      assert.deepEqual(rows.find((row) => row.event === "case_failed").budgetAccounting.unresolvedExposure,
        mode === "settled" ? noReservations : exposureOf(configuredCap));
    });
  }
});

test("dist Gateway drained journals do not release exposure on timeout or abort", async (t) => {
  const { BudgetLedger } = await import("../dist/bridge/budget-ledger.js");
  for (const mode of ["timeout", "signal abort", "remote abort"]) {
    await t.test(mode, async (t) => {
      const controller = new AbortController();
      const f = await fixture(t, { configured: true, runtimeCap: configuredCap, runtimeLedgerClass: BudgetLedger,
        dropFinal: mode !== "remote abort",
        extraEvents: mode === "remote abort" ? [({ sessionKey, idempotencyKey }) => ({
          event: "chat", payload: { sessionKey, runId: idempotencyKey, state: "aborted" },
        })] : [],
        async onRuntimeLedger(ledger) {
          const request = await ledger.reserve({ maxTokens: 32 });
          await ledger.settle({ requestId: request.requestId, usage });
          await ledger.finish();
          if (mode === "signal abort") controller.abort(new Error("Synthetic caller abort"));
        },
      });
      f.context.signal = controller.signal;
      await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
        assert.deepEqual(error.budgetAccounting.unresolvedExposure, exposureOf(configuredCap));
        assert.deepEqual(error.budgetAccounting.reserved, noReservations);
        assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, usage.input);
        return true;
      });
      assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
      assert.deepEqual(f.reported, []);
    });
  }
});

test("enforced Gateway rejects priced and currency allocations before preparation while legacy stays observational", async (t) => {
  for (const hook of [false, true]) {
    for (const scope of ["case", "campaign"]) {
      for (const caps of [{ priced: true }, { priced: true, currencyMicros: 100 }, { currencyMicros: 100 },
        { priced: false, currencyMicros: 0 }, { currencyMicros: null }]) {
        let prepares = 0;
        const f = await fixture(t, { configured: !hook, runtimeBudget: hook, runtimeCap: configuredCap,
          onPrepare() { prepares++; } });
        const task = item();
        if (scope === "case") task.limits.usage = caps;
        else f.context.budget = caps;
        const result = await f.adapter.executeCase(task, f.context);
        assert.equal(result.executionStatus, "infrastructure_blocked");
        assert.match(result.policyFacts.blockedReason, /priced\/currency.*operator/);
        assert.equal(f.calls.length + prepares, 0);
      }
    }
  }
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ limits: { timeoutMs: 2000,
    usage: { priced: true, currencyMicros: 100 } } }), { ...f.context, budget: { priced: true, currencyMicros: 100 } });
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.budgetAttestation.status, "legacy-unattested");
});

test("each installed Gateway input cap must fit uncached and cache ceilings before configured admission", async (t) => {
  for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    for (const scope of ["case", "campaign"]) {
      for (const cap of [0, configuredCap.maxInputTokens - 1]) {
        const f = await fixture(t, { configured: true, runtimeCap: configuredCap });
        const task = item();
        if (scope === "case") task.limits.usage = { [field]: cap };
        else f.context.budget = { [field]: cap };
        const result = await f.adapter.executeCase(task, f.context);
        assert.equal(result.executionStatus, "infrastructure_blocked");
        assert.match(result.policyFacts.blockedReason, /operator|exhausted/);
        assert.equal(f.calls.length, 0);
      }
    }
  }
});

test("remaining cache-read and cache-write caps block later Gateway turns independently in every scope", async (t) => {
  for (const hook of [false, true]) {
    for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
      for (const scope of ["case", "campaign"]) {
        const cap = hook ? 128 : configuredCap.maxInputTokens;
        const f = await fixture(t, { configured: !hook, runtimeBudget: hook, runtimeCap: configuredCap,
          ...(hook ? { mutateAdmission({ runtimeConfig, ledger }) {
            runtimeConfig.operationalBudget.maxInputTokens = cap;
            ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
          } } : {}),
          providerUsage: { input: 3, output: 2, cacheRead: field === "cacheReadTokens" ? 8 : 0,
            cacheWrite: field === "cacheWriteTokens" ? 8 : 0 } });
        f.context.operationalBudget = { ...configuredCap, maxDurationMs: 5000,
          maxModelRequests: configuredCap.maxModelRequests * 3, maxInputTokens: cap * 3,
          maxOutputTokens: configuredCap.maxOutputTokens * 3, maxToolCalls: configuredCap.maxToolCalls * 3 };
        const task = item({ turns: ["first", "second"] });
        if (scope === "case") task.limits.usage = { [field]: cap };
        else f.context.budget = { [field]: cap };
        if (hook) {
          await assert.rejects(f.adapter.executeCase(task, f.context), new RegExp(`${field}.*operator`));
          assert.equal(f.reported.length, 1);
        } else {
          const result = await f.adapter.executeCase(task, f.context);
          assert.equal(result.executionStatus, "infrastructure_blocked");
          assert.match(result.policyFacts.blockedReason, new RegExp(`${field}.*operator`));
          assert.equal(result.turns.length, 1);
          assert.equal(result.usage[field], 8);
        }
        assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
      }
    }
  }
});

test("custom Gateway hooks must prove actual total input caps within each cache allocation before dispatch", async (t) => {
  for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
    const f = await fixture(t, { runtimeBudget: true });
    f.context.budget = { [field]: 128 };
    await assert.rejects(f.adapter.executeCase(item(), f.context), (error) => {
      assert.match(error.message, new RegExp(`${field}.*operator`));
      assert.deepEqual(error.budgetAccounting.reserved, noReservations);
      assert.deepEqual(error.budgetAccounting.unresolvedExposure, exposureOf({ ...operationalBudget, maxDurationMs: 500 }));
      return true;
    });
    assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 0);
  }
  const f = await fixture(t, { runtimeBudget: true, mutateAdmission({ runtimeConfig, ledger }) {
    runtimeConfig.operationalBudget.maxInputTokens = 128;
    ledger.configSha256 = hash(JSON.stringify(runtimeConfig));
  } });
  f.context.budget = { cacheReadTokens: 128, cacheWriteTokens: 128 };
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.budgetAttestation.proofs[0].operationalBudget.maxInputTokens, 128);
});

test("incomplete native receipts and wrong model route cannot use zero-usage fallback", () => {
  const rows = nativeRows();
  assert.throws(() => nativeTurnEvidence(rows.filter((row) => row.type !== "tool/result"), { usage }), /terminal result/);
  const missingRoute = [rows[2], ...rows.filter((row) => row.type !== "request/header")];
  assert.throws(() => nativeTurnEvidence(missingRoute, { usage }), /github-copilot/);
  rows[2].data.header.config.model = "wrong-model";
  assert.throws(() => nativeTurnEvidence(rows, { usage }), /gpt-6-astra/);
});

test("Gateway config rejects non-loopback endpoints and embedded credentials", async (t) => {
  const f = await fixture(t);
  for (const url of ["wss://example.com", "ws://secret@127.0.0.1:18789"]) {
    await assert.rejects(createGatewayAcceptanceAdapter({ config: { ...f.config, gatewayUrl: url } }), /loopback/);
  }
});
