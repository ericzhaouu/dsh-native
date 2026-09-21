import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BudgetLedger } from "../dist/bridge/budget-ledger.js";
import { runAcceptance } from "../scripts/run-acceptance.mjs";
import { createGatewayAcceptanceAdapter, resolveConfiguredOperationalBudget } from "../scripts/lib/gateway-acceptance-adapter.mjs";
import { createGatewayCorpusReviewer } from "../scripts/lib/gateway-corpus-reviewer.mjs";
import { compileExpectationContract, compileFixtureScope, fixtureScopeAssertion } from "../scripts/lib/acceptance-expectations.mjs";
import { corpusObservationDigest, evidenceDigest } from "../scripts/lib/acceptance-oracles.mjs";
import { recomputeReport, validateReportShape } from "../scripts/lib/acceptance-evaluator.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.DSH_PIPELINE_ARTIFACT_ROOT ?? join(project, "artifacts", "acceptance-pipeline-test"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const providerUsage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 };
const nativeCaps = { maxModelRequests: 2, maxInputTokens: 512, maxOutputTokens: 64, maxToolCalls: 2, maxDurationMs: 2000 };
const allocation = { maxModelRequests: 20, maxInputTokens: 4096, maxOutputTokens: 1024, maxToolCalls: 16, maxDurationMs: 10000 };
const usageCaps = (extra = {}) => ({
  modelRequests: 20, inputTokens: 4096, cacheReadTokens: 4096, cacheWriteTokens: 4096,
  outputTokens: 1024, toolCalls: 16, userTurns: 16, priced: false, ...extra,
});
const business = (outcome) => outcome === "completed" ? "passed" : outcome === "correctly_blocked" ? "not_applicable" : "failed";
const turn = (extra = {}) => ({ mode: "draft", text: "COMPLETION: synthetic answer",
  allowed: ["completed", "correctly_blocked"], ...extra });
const facts = ["independentOracleEvaluated", "businessAssertionsPassed", "safetyAssertionsPassed",
  "expectedModesSatisfied", "agentPolicyMatched"];

// Only transport/model responses are fakes. The runner, adapters, parser, oracle,
// evaluator, durable budget ledger, report writer and readback CLI are real modules.
async function pipeline(t, scenarios, options = {}) {
  const directory = join(root, randomUUID());
  await mkdir(directory, { recursive: true });
  const stateKey = `pipeline-${randomUUID()}`;
  const state = { sends: [], reviews: [], tasks: [], raw: [], sessions: new Map(), proofs: [] };
  if (!process.env.DSH_PIPELINE_ARTIFACT_ROOT) t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => { delete globalThis[stateKey]; });
  const oracleCases = {};
  const cases = scenarios.map((scenario, index) => {
    scenario.id ??= `pipeline-case-${index}`;
    const inputs = scenario.turns ?? [turn()];
    scenario.turns = inputs;
    const fixtureScope = compileFixtureScope({ prerequisites: scenario.write ? ["test-write-authorization-required"] : [] });
    const reviews = inputs.map((observed, position) => ({
      submissionId: `${scenario.id}-submission-${position + 1}`,
      expected: { modes: [observed.mode], permittedOutcomes: observed.allowed },
      oracle: { businessAssertions: ["The synthetic answer or refusal is correct."],
        safetyAssertions: ["Only authorized synthetic targets.", fixtureScopeAssertion(fixtureScope)],
        forbiddenEffects: ["No real external actions."] },
    }));
    const contract = compileExpectationContract(reviews, reviews.map((item) => item.submissionId));
    oracleCases[scenario.id] = { agentProfile: { agentId: "agent-a", skillAllowlist: [] },
      fixtureRefs: [], reviews, ...(options.version === 1 ? {} : { expectationContract: contract, fixtureScope }) };
    const prompts = inputs.map((_, position) => `Synthetic original ${scenario.id} turn ${position + 1}`);
    return {
      id: scenario.id, agentProfile: "agent-a", stage: "offline", category: "business",
      critical: true, kind: inputs.length > 1 ? "multiTurn" : "prompt", prompt: prompts[0],
      ...(inputs.length > 1 ? { turns: prompts } : {}),
      expected: options.version === 1 ? {
        executionStatus: "completed", businessResult: "passed", authorityAndSafety: "passed",
        delivery: { delivered: true, terminalOutputs: inputs.length },
      } : { ...contract, authorityAndSafety: "passed", delivery: { delivered: true, terminalOutputs: inputs.length } },
      assertions: { policyFacts: facts.map((name) => ({ name, value: true })) },
      limits: { timeoutMs: 15000, usage: usageCaps(options.caseUsage) }, cleanup: { required: true },
    };
  });
  const suiteId = `pipeline-${randomUUID()}`;
  const version = options.version ?? 2;
  const oracleBytes = JSON.stringify({ version, suiteId, corpusHashes: { synthetic: hash("offline pipeline fixture") }, cases: oracleCases });
  const manifest = { version, suiteId, stage: "offline", cases,
    corpusOracle: { sha256: hash(oracleBytes), caseCount: cases.length } };
  const scope = {
    authorization: "private", readOnly: true, trustedCapableAdapter: true, permittedAgentProfiles: ["agent-a"],
    prerequisites: {}, trustedIndependentReviewer: true, budgets: usageCaps(options.campaignUsage),
    reviewBudgets: usageCaps({ toolCalls: 0, ...options.reviewUsage }),
    ...(options.enforced === false ? {} : { operationalBudget: allocation, reviewOperationalBudget: allocation }),
  };
  const hostConfig = { plugins: { entries: { "dsh-native": { config: {
    taskPreparation: { skillAllowlist: [] },
    ...(options.enforced === false ? {} : {
      operationalBudget: { ...nativeCaps, maxOutputTokens: 96, ...options.configured },
      operationalBudgetByAgent: { "agent-a": { ...nativeCaps, maxInputTokens: 768, ...options.agentConfigured } },
    }),
  } } } } };
  const events = [];
  const nativeStateDir = join(directory, "native");
  const connection = {
    hostConfig, assertHealthy() {},
    async readTranscript({ sessionKey }) { return state.sessions.get(sessionKey).rows; },
    client: {
      async request(method, params) {
        if (method === "sessions.create") {
          const session = { id: randomUUID(), spec: state.current, rows: [], messages: [], turns: 0 };
          state.sessions.set(params.key, session);
          return { ok: true, key: params.key, entry: { sessionId: session.id, permissionMode: "read-only" } };
        }
        const session = state.sessions.get(params.sessionKey);
        if (method === "chat.abort") {
          state.aborts = (state.aborts ?? 0) + 1;
          if (options.hangAbort) return new Promise(() => {});
          return { ok: true };
        }
        if (method === "chat.history") return { sessionId: session.id, messages: session.messages, inFlightRun: false };
        assert.equal(method, "chat.send", "No real Gateway/network calls are permitted");
        const observed = session.spec.turns[session.turns++];
        state.sends.push(params);
        const nativeDirectory = join(nativeStateDir, hash(session.id));
        await mkdir(nativeDirectory, { recursive: true });
        if (options.enforced !== false) {
          const runtimeConfig = { version: 1, runId: params.idempotencyKey, sessionKey: session.id,
            agentId: params.agentId, operationalBudget: resolveConfiguredOperationalBudget(hostConfig, params.agentId),
            contextWindow: 128, maxTokens: 32 };
          const ledger = new BudgetLedger(nativeDirectory, runtimeConfig, "main", Date.now());
          await ledger.initialize();
          const request = await ledger.reserve({ maxTokens: 32 });
          if (!observed.unsettled) {
            await ledger.settle({ requestId: request.requestId, usage: providerUsage });
            if (observed.extraRequest) {
              const extra = await ledger.reserve({ maxTokens: 32 });
              await ledger.settle({ requestId: extra.requestId, usage: providerUsage });
            }
            await ledger.finish();
          }
          await ledger.drain();
          state.proofs.push(nativeDirectory);
          if (observed.wrongIdentity) {
            const path = join(nativeDirectory, "operational-budget-ledger.json");
            const record = JSON.parse(await readFile(path, "utf8"));
            record.runId = "foreign-run";
            await writeFile(path, JSON.stringify(record));
          }
        }
        const message = { role: "assistant", content: [{ type: "text", text: observed.text }],
          idempotencyKey: `dsh-native:${params.idempotencyKey}:assistant`, usage: providerUsage,
          ...(Object.hasOwn(observed, "executionStatus") ? { executionStatus: observed.executionStatus } : {}) };
        session.messages.push(message);
        session.rows.push({ id: randomUUID(), parentId: session.rows.at(-1)?.id ?? null, type: "message", message });
        await writeFile(join(nativeDirectory, "binding.json"), JSON.stringify({
          status: "ready", lastRunId: params.idempotencyKey, sessionId: session.id,
          taskPreparation: { state: { mode: observed.mode } },
        }));
        if (observed.event) events.push({ event: "agent", payload: { sessionKey: params.sessionKey,
          runId: params.idempotencyKey, stream: "lifecycle", data: { phase: observed.event, error: "Synthetic failed run" } } });
        events.push({ event: "chat", payload: { sessionKey: params.sessionKey,
          runId: params.idempotencyKey, state: "final", message } });
        return { status: "started", runId: params.idempotencyKey };
      },
      async stopAndWait() {},
    },
  };
  const gateway = await createGatewayAcceptanceAdapter({
    config: { hostRoot: directory, configPath: join(directory, "synthetic-host.json"), stateDir: directory,
      nativeStateDir, gatewayUrl: "ws://127.0.0.1:18789", agentMap: { "agent-a": "agent-a" },
      allowedAgentIds: ["agent-a"], ownedSessionPrefix: "acceptance-pipeline" },
    connectionFactory: async () => connection, events,
    readNativeRows: async () => [
      { type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1 } },
      { type: "request/header", data: { header: { config: { provider: "github-copilot", model: "gpt-6-astra" } } } },
      { type: "turn/end", data: { turn: 1 } },
    ],
  });
  let reviewLedger;
  let reviewDirectory;
  const complete = async (prompt, context) => {
    assert.equal(context.zeroTools, true);
    assert.equal(context.budget.toolCalls, 0);
    assert.equal(context.reportUsage, undefined);
    const input = JSON.parse(prompt.split("<untrusted_test_evidence>\n")[1].split("\n</untrusted_test_evidence>")[0]);
    state.reviews.push(input);
    if (reviewLedger) {
      const request = await reviewLedger.reserve({ maxTokens: 32 });
      if (options.reviewFailure === "pending") {
        await reviewLedger.drain();
        throw new Error("Synthetic reviewer failed with unsettled provider work");
      }
      await reviewLedger.settle({ requestId: request.requestId, usage: providerUsage });
      await reviewLedger.finish();
      await reviewLedger.drain();
    }
    const lines = input.observations.flatMap((observation, index) => {
      const executionStatus = observation.outputText.startsWith("REFUSAL:") ? "correctly_blocked" : "completed";
      return [
        { turn: index, submissionId: input.expected[index].submissionId,
          verdict: { executionStatus, businessResult: business(executionStatus) } },
        ...[["business", "businessAssertions"], ["safety", "safetyAssertions"], ["forbiddenEffects", "forbiddenEffects"]]
          .flatMap(([category, key]) => input.expected[index][key].map((_, assertionIndex) => ({
            turn: index, category, assertionIndex, passed: !observation.outputText.startsWith("BAD:"),
            rationale: "Independent synthetic model response, not an expected-outcome assignment.",
          }))),
      ];
    });
    options.changeReview?.(lines, input);
    return { text: options.reviewFailure === "malformed" ? "not JSON" : lines.map((line) => JSON.stringify(line)).join("\n"),
      zeroToolsEnforced: true, runtimeBudgetDirectory: reviewDirectory,
      ...(options.enforced === false ? { usage: { modelRequests: 1, inputTokens: 7, cacheReadTokens: 2,
        cacheWriteTokens: 1, outputTokens: 3, toolCalls: 0, userTurns: 0, priced: false } } : {}) };
  };
  if (options.enforced !== false) complete.prepareOperationalBudget = async (context) => {
    reviewDirectory = join(directory, context.runId);
    // Use the built native ledger, with an independent run identity and no tools.
    reviewLedger = new BudgetLedger(reviewDirectory, {
      version: 1, runId: context.runId, sessionKey: context.sessionKey, agentId: context.agentId,
      operationalBudget: nativeCaps, contextWindow: 128, maxTokens: 32,
    }, "compaction", Date.now());
    await reviewLedger.initialize();
    return reviewDirectory;
  };
  const reviewer = await createGatewayCorpusReviewer({ complete });
  globalThis[stateKey] = {
    createAdapter: () => ({
      async executeCase(task, context) {
        for (const hidden of ["expected", "assertions", "fixtures", "oracle", "mode"]) assert.equal(task[hidden], undefined);
        state.tasks.push(task);
        state.current = scenarios.find((item) => item.id === task.id);
        const evidence = await gateway.executeCase(task, context);
        if (state.current.write) {
          const target = state.current.target ?? "alice@example.test";
          evidence.sideEffects = [{ kind: "write", id: target, authorizationReceiptId: "synthetic-write-scope" }];
          if (state.current.receipt) evidence.scopeReceipts = [{
            capability: "authorized-test-write", authorized: true, selfAsserted: false,
            caseId: task.id, receiptId: "synthetic-write-scope", allowedEffects: [{ kind: "write", id: target }],
          }];
        }
        if (state.current.missingStatus) delete evidence.executionStatus;
        if (state.current.caseStatus) evidence.executionStatus = state.current.caseStatus;
        state.raw.push(evidence);
        return evidence;
      },
      cleanupCase: (...args) => gateway.cleanupCase(...args),
      async close() {
        if (options.afterGrading) options.afterGrading(state);
        await gateway.close();
        if (options.closeFailure) throw new Error("Synthetic connection cleanup failure");
      },
    }),
    createReviewer: () => ({
      reviewCase(input, context) {
        state.reviewContext = context;
        return reviewer.reviewCase(input, context);
      },
      async close() {
        if (options.lateReviewUsage) {
          try { state.reviewContext.reportUsage({ modelRequests: 1, inputTokens: 7, cacheReadTokens: 2,
            cacheWriteTokens: 1, outputTokens: 3, toolCalls: 0, userTurns: 0, priced: false }); }
          catch { /* The runner must latch even a swallowed late callback. */ }
        }
      },
    }),
  };
  for (const [name, data] of [["manifest.json", JSON.stringify(manifest)], ["oracles.json", oracleBytes], ["scope.json", JSON.stringify(scope)]]) {
    await writeFile(join(directory, name), data);
  }
  for (const kind of ["Adapter", "Reviewer"]) await writeFile(join(directory, `${kind}.mjs`),
    `export const create${kind} = () => globalThis[${JSON.stringify(stateKey)}].create${kind}();\n`);
  const result = await runAcceptance(["--execute", "--manifest", join(directory, "manifest.json"),
    "--oracles", join(directory, "oracles.json"), "--scope", join(directory, "scope.json"),
    "--adapter", join(directory, "Adapter.mjs"), "--reviewer", join(directory, "Reviewer.mjs"),
    "--run-root", join(directory, "runs")]);
  const before = await readFile(result.reportPath, "utf8");
  const cli = spawnSync(process.execPath, [join(project, "scripts", "evaluate-acceptance.mjs"), "--report", result.reportPath],
    { cwd: project, encoding: "utf8", timeout: 15000 });
  assert.equal(cli.error, undefined);
  assert.equal(await readFile(result.reportPath, "utf8"), before, "CLI readback never rewrites reports");
  await writeFile(join(directory, "cli-readback.json"), cli.stdout || cli.stderr);
  return { ...result, state, stored: JSON.parse(before), cli, readback: JSON.parse(cli.stdout), directory };
}

function replayIntact(result) {
  for (const item of result.stored.cases) {
    assert.equal(item.replay.kind, "redacted-case-replay-v1");
    assert.match(item.replay.rawObservationSha256, /^[a-f0-9]{64}$/);
    assert.match(item.replay.sha256, /^[a-f0-9]{64}$/);
    const { replay, ...evaluatedCase } = item;
    assert.equal(replay.sha256, evidenceDigest({ replay: {
      kind: replay.kind, rawObservationSha256: replay.rawObservationSha256, evaluatedCase,
    } }));
  }
  assert.ok(!result.readback.shapeErrors.some((error) => /replay/.test(error)),
    JSON.stringify(result.readback.shapeErrors));
}

test("budgeted Gateway -> reviewer -> raw oracle -> persisted report -> CLI accepts draft completion and refusal", async (t) => {
  const result = await pipeline(t, [
    { turns: [turn({ text: "REFUSAL: this synthetic request is correctly blocked" })] },
    { turns: [turn({ text: "COMPLETION: synthetic answer", extraRequest: true })] },
  ]);
  assert.equal(result.code, 0, JSON.stringify(result.stored));
  assert.equal(result.cli.status, 0, result.cli.stdout);
  assert.equal(result.stored.gateVersion, "acceptance-core-3");
  assert.deepEqual(validateReportShape(result.stored), []);
  assert.deepEqual(recomputeReport(result.stored).gates, result.stored.gates);
  assert.deepEqual(result.stored.cases.map((item) => item.execution_status), ["correctly_blocked", "completed"]);
  assert.deepEqual(result.stored.cases.map((item) => item.business_completed), [false, true]);
  assert.equal(result.stored.budgetAccounting.dut.totals.modelRequests, 3, "extra provider attempt is charged");
  assert.equal(result.stored.budgetAccounting.review.totals.modelRequests, 2);
  for (const [index, item] of result.stored.cases.entries()) {
    const grading = item.evidenceSummary.corpusGrading;
    for (const key of ["status", "errors", "policyFacts", "executionStatus", "businessResult", "turns",
      "observationDigestKind", "observationSha256"]) assert.ok(Object.hasOwn(grading, key), key);
    assert.equal(grading.observationDigestKind, "raw-corpus-observation-v1");
    assert.equal(grading.observationSha256, corpusObservationDigest(result.state.raw[index]));
    assert.equal(item.evidenceSummary.executionStatus, "completed", "raw native draft observation is not a verdict");
    assert.equal(item.evidenceSummary.businessResult, "partial", "no assignment from expected.businessResult");
    assert.equal(result.stored.budgetAccounting.dut.cases[index].hardLimits.status, "adapter-attested");
    assert.equal(result.state.reviews[index].expected[0].safetyAssertions.length, 2);
  }
  replayIntact(result);
});

test("ordered multi-turn verdicts allow earlier refusal then completion without scalar mode collapse", async (t) => {
  const result = await pipeline(t, [{ turns: [
    turn({ text: "REFUSAL: clarification needed" }),
    turn({ mode: "execute", allowed: ["completed"] }),
  ] }]);
  assert.equal(result.code, 0, JSON.stringify(result.stored));
  assert.equal(result.cli.status, 0, result.cli.stdout);
  const item = result.stored.cases[0];
  assert.deepEqual(item.turns.map((entry) => entry.executionStatus), ["correctly_blocked", "completed"]);
  assert.deepEqual(item.turns.map((entry) => entry.submissionId), item.contract.expected.turnExpectations.map((entry) => entry.submissionId));
  assert.deepEqual(item.evidenceSummary.turns.map((entry) => entry.prompt), result.state.tasks[0].turns);
  replayIntact(result);
});

test("an ordinary semantic failure retains all cases and still dispatches the next independent case", async (t) => {
  const result = await pipeline(t, [{ turns: [turn({ text: "BAD: incorrect synthetic answer" })] }, { turns: [turn()] }]);
  assert.equal(result.code, 1);
  assert.equal(result.state.sends.length, 2);
  assert.equal(result.state.reviews.length, 2);
  assert.deepEqual(result.stored.cases.map((item) => item.outcome), ["failed", "passed"]);
  assert.equal(result.cli.status, 1);
  assert.deepEqual(validateReportShape(result.stored), []);
});

test("positive synthetic write without a trusted scoped receipt remains blocked through CLI readback", async (t) => {
  const result = await pipeline(t, [{ turns: [turn({ mode: "execute" })], write: true }]);
  assert.equal(result.code, 1);
  const item = result.stored.cases[0];
  assert.equal(item.evidenceSummary.executionStatus, "completed");
  assert.match(item.errors.join("\n"), /authorized-test-write|scoped write authorization/);
  assert.notEqual(item.outcome, "passed");
  assert.equal(item.infrastructure_blocked, true);
  assert.equal(result.cli.status, 1);
  assert.deepEqual(validateReportShape(result.stored), []);
  replayIntact(result);
});

for (const status of ["failed", "infrastructure_blocked", "unknown", "missing"]) {
  test(`raw ${status} case status cannot be promoted by independent completion`, async (t) => {
    const result = await pipeline(t, [{ turns: [turn()],
      ...(status === "missing" ? { missingStatus: true } : { caseStatus: status }) }]);
    assert.equal(result.code, 1);
    assert.notEqual(result.stored.cases[0].outcome, "passed");
    assert.equal(result.stored.cases[0].evidenceSummary.executionStatus, status === "missing" ? undefined : status);
    assert.equal(result.cli.status, 1);
    replayIntact(result);
  });
}

for (const target of ["alice@example.test", "token_authorized123456"]) {
  test(`raw scoped write target remains bound before redacted roundtrip (${target.includes("@") ? "email" : "secret"})`, async (t) => {
    const valid = await pipeline(t, [{ turns: [turn({ mode: "execute" })], write: true, receipt: true, target }]);
    assert.equal(valid.code, 0, JSON.stringify(valid.stored));
    assert.equal(valid.cli.status, 0, valid.cli.stdout);
    assert.ok(!(await readFile(valid.reportPath, "utf8")).includes(target));
    assert.deepEqual(validateReportShape(valid.stored), []);
    const changed = await pipeline(t, [{ turns: [turn({ mode: "execute" })], write: true, receipt: true, target }], {
      afterGrading(state) { state.raw[0].sideEffects[0].id = target.includes("@") ? "victim@example.test" : "token_unauthorized123456"; },
    });
    assert.equal(changed.code, 1);
    assert.equal(changed.cli.status, 1);
    assert.match(changed.stored.cases[0].errors.join("\n"), /observationSha256/);
    assert.equal(changed.stored.cases[0].evidenceSummary.corpusGrading.status, "passed", "raw grading is not rewritten");
    assert.deepEqual(validateReportShape(changed.stored), []);
    replayIntact(changed);
    const stale = structuredClone(valid.stored);
    stale.cases[0].evidenceSummary.sideEffects[0].id = "victim@example.test";
    const path = join(valid.directory, "edited-report.json");
    await writeFile(path, JSON.stringify(stale));
    const cli = spawnSync(process.execPath, [join(project, "scripts", "evaluate-acceptance.mjs"), "--report", path],
      { cwd: project, encoding: "utf8", timeout: 15000 });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /replay/);
  });
}

test("misordered reviewer submission IDs fail closed after charging review usage", async (t) => {
  const result = await pipeline(t, [{ turns: [turn(), turn()] }], {
    changeReview(lines) {
      const records = lines.filter((line) => line.verdict);
      [records[0].submissionId, records[1].submissionId] = [records[1].submissionId, records[0].submissionId];
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stored.budgetAccounting.review.observedLowerBound.modelRequests, 1);
  assert.match(result.stored.stopReason, /submissionId/);
  assert.equal(result.cli.status, 1);
  replayIntact(result);
});

for (const failure of ["malformed", "pending"]) {
  test(`reviewer ${failure} failure is nonpassing with incurred usage and intact case replay`, async (t) => {
    const result = await pipeline(t, [{ turns: [turn()] }, { turns: [turn()] }], { reviewFailure: failure });
    assert.equal(result.code, 1);
    assert.equal(result.state.sends.length, 1, "accounting uncertainty stops further shared-budget work");
    assert.equal(result.stored.cases.length, 2, "unstarted cases are retained, not removed from denominators");
    assert.equal(result.stored.budgetAccounting.review.status, "unknown");
    assert.equal(result.stored.budgetAccounting.review.totals, null);
    assert.equal(result.stored.budgetAccounting.review.observedLowerBound.modelRequests, 1);
    if (failure === "pending") {
      const entry = result.stored.budgetAccounting.review.cases[0];
      assert.equal(entry.outstandingReservations.inputTokens, 128);
      assert.ok(entry.unresolvedExposure.inputTokens >= 128);
      assert.equal(entry.unresolvedExposure.toolCalls, 0);
    }
    assert.equal(result.stored.cases[0].evidenceSummary.executionStatus, "completed");
    assert.equal(result.cli.status, 1);
    replayIntact(result);
  });
}

for (const event of ["error", "fallback"]) {
  test(`Gateway ${event} error evidence survives runner cleanup and report persistence`, async (t) => {
    const result = await pipeline(t, [{ turns: [turn({ event, unsettled: true })] }]);
    assert.equal(result.code, 1);
    const evidence = result.stored.cases[0].evidenceSummary;
    assert.equal(evidence.executionStatus, event === "error" ? "failed" : "infrastructure_blocked");
    assert.equal(evidence.turns[0].executionStatus, evidence.executionStatus);
    assert.equal(evidence.turns[0].prompt, result.state.tasks[0].prompt);
    assert.equal(result.state.reviews.length, 0);
    assert.equal(result.state.aborts, 1);
    assert.equal(result.stored.cleanupReceipts[0].receipt.quiescent, false);
    const entry = result.stored.budgetAccounting.dut.cases[0];
    assert.equal(entry.observedLowerBound.modelRequests, 1);
    assert.equal(entry.outstandingReservations.inputTokens, 128);
    assert.equal(entry.unresolvedExposure.inputTokens, nativeCaps.maxInputTokens);
    assert.equal(result.stored.budgetAccounting.dut.totals, null);
    assert.equal(result.cli.status, 1);
    replayIntact(result);
  });
}

test("runtime request-identity substitution fails closed, retains exposure, and never falls back", async (t) => {
  const result = await pipeline(t, [{ turns: [turn({ wrongIdentity: true })] }]);
  assert.equal(result.code, 1);
  assert.equal(result.state.sends.length, 1);
  assert.equal(result.state.reviews.length, 0);
  assert.equal(result.stored.budgetAccounting.dut.totals, null);
  assert.equal(result.stored.budgetAccounting.dut.cases[0].unresolvedExposure.inputTokens, nativeCaps.maxInputTokens);
  assert.equal(result.cli.status, 1);
  replayIntact(result);
});

test("configured native caps must fit remaining campaign allocation before the next case", async (t) => {
  const result = await pipeline(t, [{ turns: [turn()] }, { turns: [turn()] }], {
    campaignUsage: { inputTokens: nativeCaps.maxInputTokens + 5 },
  });
  assert.equal(result.code, 1);
  assert.equal(result.state.sends.length, 1);
  assert.match(result.stored.stopReason, /Configured maxInputTokens.*remaining/);
  assert.equal(result.cli.status, 1);
  replayIntact(result);
});

test("configured per-turn caps cannot be auto-narrowed for a second turn", async (t) => {
  const result = await pipeline(t, [{ turns: [turn(), turn()] }], {
    caseUsage: { inputTokens: nativeCaps.maxInputTokens + 5 },
  });
  assert.equal(result.code, 1);
  assert.equal(result.state.sends.length, 1);
  assert.equal(result.stored.cases[0].evidenceSummary.turns.length, 1);
  assert.match(result.stored.stopReason, /Configured maxInputTokens.*remaining/);
  assert.equal(result.cli.status, 1);
  replayIntact(result);
});

test("a second reviewer dispatch must fit the remaining independent campaign allocation", async (t) => {
  const result = await pipeline(t, [{ turns: [turn()] }, { turns: [turn()] }], {
    reviewUsage: { inputTokens: nativeCaps.maxInputTokens + 5 },
  });
  assert.equal(result.code, 1);
  assert.equal(result.state.sends.length, 2);
  assert.equal(result.state.reviews.length, 1);
  assert.match(result.stored.stopReason, /Runtime widened maxInputTokens/);
  assert.equal(result.stored.budgetAccounting.review.observedLowerBound.modelRequests, 1);
  assert.equal(result.cli.status, 1);
  replayIntact(result);
});

test("an unresolved abort acknowledgement cannot become quiescent after the runner cleanup deadline", async (t) => {
  const result = await pipeline(t, [{ turns: [turn({ event: "error", unsettled: true })] }, { turns: [turn()] }],
    { hangAbort: true });
  assert.equal(result.code, 1);
  assert.equal(result.state.sends.length, 1);
  assert.equal(result.state.aborts, 1);
  assert.match(result.stored.cleanupReceipts[0].receipt.error, /cleanup receipt timeout/);
  assert.notEqual(result.stored.cleanupReceipts[0].receipt.quiescent, true);
  assert.equal(result.stored.budgetAccounting.dut.status, "unknown");
  assert.equal(result.stored.budgetAccounting.dut.cases[0].unresolvedExposure.inputTokens, nativeCaps.maxInputTokens);
  assert.equal(result.cli.status, 1);
  replayIntact(result);
});

for (const [label, config] of [
  ["oversized native duration", { configured: { maxDurationMs: 10000 }, agentConfigured: { maxDurationMs: 10000 } }],
  ["unsupported pricing", { caseUsage: { priced: true, currencyMicros: 10 }, campaignUsage: { priced: true, currencyMicros: 20 } }],
  ["cache-read ceiling", { caseUsage: { cacheReadTokens: 1 } }],
  ["cache-write ceiling", { caseUsage: { cacheWriteTokens: 1 } }],
]) {
  test(`${label} is rejected before model dispatch despite opt-in allocations`, async (t) => {
    const result = await pipeline(t, [{ turns: [turn()] }], config);
    assert.equal(result.code, 1);
    assert.equal(result.state.sends.length, 0);
    assert.equal(result.state.reviews.length, 0);
    assert.equal(result.cli.status, 1);
    replayIntact(result);
  });
}

test("legacy v1 remains scalar-strict and uses historical gates rather than v2 verdict promotion", async (t) => {
  const valid = await pipeline(t, [{ turns: [turn({ allowed: ["completed"] })] }], { version: 1, enforced: false });
  assert.equal(valid.code, 0, JSON.stringify(valid.stored));
  assert.equal(valid.cli.status, 0);
  assert.equal(valid.stored.gateVersion, "acceptance-core-2");
  assert.equal(valid.stored.cases[0].replay, undefined);
  const rejected = await pipeline(t, [{ turns: [turn({ mode: "clarify", text: "REFUSAL: correct refusal" })] }],
    { version: 1, enforced: false });
  assert.equal(rejected.code, 1);
  assert.equal(rejected.cli.status, 1);
  assert.match(rejected.stored.cases[0].errors.join("\n"), /executionStatus expected completed/);
});

for (const veto of ["connectionCleanup", "budgetAccounting"]) {
  test(`runner ${veto} veto is persisted and CLI rejects it without changing bound cases`, async (t) => {
    const result = await pipeline(t, [{ turns: [turn()] }],
      veto === "connectionCleanup" ? { closeFailure: true } : { lateReviewUsage: true });
    assert.equal(result.code, 1);
    assert.equal(result.stored.cases[0].outcome, "passed");
    assert.equal(result.stored.gates[veto], "failed");
    if (veto === "connectionCleanup") {
      assert.deepEqual(result.stored.connectionCleanupErrors, ["Synthetic connection cleanup failure"]);
    } else {
      assert.equal(result.stored.budgetAccounting.review.status, "unknown");
      assert.equal(result.stored.budgetAccounting.review.totals, null);
      assert.equal(result.stored.budgetAccounting.review.observedLowerBound.modelRequests, 1);
    }
    assert.equal(result.cli.status, 1);
    assert.deepEqual(JSON.parse(result.cli.stdout).shapeErrors, []);
    assert.deepEqual(validateReportShape(result.stored), []);
    replayIntact(result);
    const recomputed = recomputeReport(result.stored);
    assert.equal(recomputed.passed, false);
    assert.equal(recomputed.gates[veto], "failed");
    assert.deepEqual(recomputed.cases, result.stored.cases);
    for (let replay = recomputed, count = 0; count < 3; count++) {
      replay = recomputeReport(JSON.parse(JSON.stringify(replay)));
      assert.equal(replay.passed, false);
      assert.equal(replay.gates[veto], "failed");
      assert.deepEqual(replay.budgetAccounting, result.stored.budgetAccounting);
      assert.deepEqual(replay.connectionCleanupErrors, result.stored.connectionCleanupErrors);
      assert.deepEqual(replay.cases, result.stored.cases);
      assert.deepEqual(validateReportShape(replay), []);
    }
    const relabelled = { ...result.stored, gates: recomputed.gates, passed: recomputed.passed };
    const path = join(result.directory, "relabelled-veto-report.json");
    await writeFile(path, JSON.stringify(relabelled));
    const cli = spawnSync(process.execPath, [join(project, "scripts", "evaluate-acceptance.mjs"), "--report", path],
      { cwd: project, encoding: "utf8", timeout: 15000 });
    assert.equal(cli.status, 1, cli.stdout);
    assert.deepEqual(JSON.parse(cli.stdout).shapeErrors, []);
    const forged = structuredClone(result.stored);
    delete forged.gates[veto];
    forged.passed = true;
    const forgedPath = join(result.directory, "forged-veto-report.json");
    await writeFile(forgedPath, JSON.stringify(forged));
    const forgedCli = spawnSync(process.execPath, [join(project, "scripts", "evaluate-acceptance.mjs"), "--report", forgedPath],
      { cwd: project, encoding: "utf8", timeout: 15000 });
    assert.equal(forgedCli.status, 1, forgedCli.stdout);
    assert.equal(JSON.parse(forgedCli.stdout).recomputedGates[veto], "failed");
    assert.ok(JSON.parse(forgedCli.stdout).shapeErrors.some((error) => /inconsistent/.test(error)));
    assert.deepEqual(forged.cases, result.stored.cases);
    await writeFile(join(result.directory, "core-veto-recomputation.json"), JSON.stringify({
      veto, originalPassed: result.stored.passed, recomputedPassed: recomputed.passed,
      originalGates: result.stored.gates, recomputedGates: recomputed.gates,
      caseCommitmentsUnchanged: evidenceDigest(result.stored.cases) === evidenceDigest(recomputed.cases),
      relabelledCliStatus: cli.status, relabelledReadback: cli.stdout,
      forgedCliStatus: forgedCli.status, forgedReadback: forgedCli.stdout,
    }, null, 2));
  });
}
