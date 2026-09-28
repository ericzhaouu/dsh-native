import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import {
  accountVector, addAccount, createCampaignPolicy, readBudgetAuthorization, reduceBudgetJournal,
} from "../scripts/lib/acceptance-campaign-budget.mjs";
import { allocateCampaignCase, resolveHostContextWindow } from "../scripts/lib/acceptance-campaign-budget-plan.mjs";
import { CampaignError, createJournal, hash, immutable, journalWriter, readJournal } from "../scripts/lib/acceptance-campaign-state.mjs";
import { prepareCampaign, runCampaign } from "../scripts/lib/acceptance-campaign.mjs";
import { campaignEnvironment } from "./fixtures/campaign-environment.mjs";

const { root: harness, skip } = campaignEnvironment(process.platform, process.env.DSH_CAMPAIGN_TEST_ROOT);
const vector = (userTurns = 0, modelRequests = 0, inputTokens = 0, outputTokens = 0) =>
  ({ userTurns, modelRequests, inputTokens, outputTokens });
const attempt = { maxModelRequests: 8, maxInputTokens: 2000000, maxOutputTokens: 8000,
  maxToolCalls: 12, maxDurationMs: 90000 };
const settings = { caseSetupMs: 1000, reviewSetupMs: 1000 };
const testCase = { id: "multi", agentProfile: "dut", turns: [{}, {}, {}], limits: { timeoutMs: 1, usage: {} } };
const scope = { authorization: "private", readOnly: true,
  attemptBudget: attempt, reviewAttemptBudget: attempt };
const plan = allocateCampaignCase(testCase, scope, settings);

test("T native attempts and one reviewer share aggregate input, not six independent authorizations", () => {
  assert.deepEqual(plan.scope.attemptBudget, attempt);
  assert.equal(plan.scope.caseBudget.maxModelRequests, 24);
  assert.equal(plan.scope.caseBudget.maxInputTokens, 6000000);
  assert.equal(plan.scope.caseBudget.maxOutputTokens, 24000);
  assert.equal(plan.scope.caseBudget.maxToolCalls, 36);
  assert.equal(plan.scope.caseBudget.maxDurationMs, 271000);
  assert.deepEqual(plan.reservation, vector(3, 32, 8000000, 32000));
  assert.deepEqual(plan.scope.reviewCaseBudget, { ...attempt, maxDurationMs: 91000 });
  for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    assert.equal(plan.testCase.limits.usage[field], 6000000);
    assert.equal(plan.scope.reviewBudgets[field], 2000000);
  }
  assert.equal(plan.testCase.limits.usage.userTurns, 3);
  assert.equal(plan.scope.reviewBudgets.userTurns, 1);
  assert.equal(plan.pools.dut.userTurns, 3);
  assert.equal(plan.pools.review.userTurns, 0);
  assert.equal(plan.scope.reviewBudgets.toolCalls, 0);
  assert.equal(testCase.limits.timeoutMs, 1);
  for (const turns of [1, 2, 5]) {
    const p = allocateCampaignCase({ ...testCase, turns: Array(turns).fill({}) }, scope, settings);
    assert.equal(p.reservation.inputTokens, attempt.maxInputTokens * (turns + 1));
  }
});

test("explicit counters reject null, empty, missing, coercible and unsafe values", () => {
  for (const value of [null, {}, "", { ...vector(), inputTokens: null },
    { ...vector(), inputTokens: "" }, { ...vector(), inputTokens: "0" },
    { ...vector(), inputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => accountVector(value), /invalid-account-vector/);
  }
  assert.deepEqual(accountVector(vector()), vector());
  assert.throws(() => addAccount(vector(0, 0, Number.MAX_SAFE_INTEGER), vector(0, 0, 1)),
    { name: "CampaignError", code: "budget-accounting-overflow" });
  assert.throws(() => addAccount(vector(), { ...vector(), inputTokens: "1" }),
    { name: "CampaignError", code: "invalid-account-vector" });
  assert.throws(() => allocateCampaignCase(testCase, { ...scope, budgets: { priced: true } }, settings),
    /budget-native-pricing-unsupported/);
  assert.throws(() => allocateCampaignCase(testCase, { ...scope, caseBudget: attempt }, settings),
    /budget-case-root-too-small/);
});

test("host context resolution uses entries, merged defaults and the largest fallback", () => {
  const host = { agents: { defaults: { model: { primary: "fixture/primary" } },
    entries: { dut: { model: { fallbacks: ["fixture/fallback"] } } } },
  models: { providers: { fixture: { models: [
    { id: "primary", contextWindow: 1000000 },
    { id: "fallback", contextWindow: 1500000 },
  ] } } } };
  assert.equal(resolveHostContextWindow(host, "dut"), 1500000);
  host.agents.defaults.model.fallbacks = ["fixture/fallback"];
  host.agents.entries.dut.model = "fixture/primary";
  assert.equal(resolveHostContextWindow(host, "dut"), 1500000);
  host.agents.entries.dut.model = { primary: "fixture/primary", fallbacks: [] };
  assert.equal(resolveHostContextWindow(host, "dut"), 1000000);
  host.agents = { defaults: host.agents.defaults, list: [{ id: "dut" }] };
  assert.equal(resolveHostContextWindow(host, "dut"), 1500000);
});

test("host context resolution rejects missing fallback context and ambiguous agent definitions", () => {
  const host = { agents: { defaults: { model: { primary: "fixture/primary" } },
    entries: { dut: { model: { fallbacks: ["fixture/fallback"] } } } },
  models: { providers: { fixture: { models: [{ id: "primary", contextWindow: 1000000 }] } } } };
  assert.throws(() => resolveHostContextWindow(host, "dut"), /budget-full-context-not-configured/);
  assert.throws(() => resolveHostContextWindow({ ...host, agents: { ...host.agents,
    list: [{ id: "dut", model: "fixture/primary" }] } }, "dut"), /budget-agent-config-ambiguous/);
  assert.throws(() => resolveHostContextWindow({ ...host, agents: {
    list: [{ id: "dut" }, { id: "dut" }] } }, "dut"), /budget-agent-config-ambiguous/);
  for (const value of [null, [], "dut", { id: "other" }]) {
    assert.throws(() => resolveHostContextWindow({ ...host, agents: { ...host.agents,
      entries: { dut: value } } }, "dut"), /budget-agent-not-configured/);
  }
});

test("host context resolution rejects malformed model routes and ambiguous full-context definitions", () => {
  const host = { agents: { defaults: { model: "fixture/primary" }, entries: { dut: {} } },
    models: { providers: { fixture: { models: [{ id: "primary", contextWindow: 1000000 }] } } } };
  for (const model of [null, [], 42, { primary: null }, { fallbacks: null },
    { fallbacks: ["fixture/missing"] }, { primary: "/primary" }, { primary: "fixture/" }]) {
    assert.throws(() => resolveHostContextWindow({ ...host, agents: { ...host.agents,
      entries: { dut: { model } } } }, "dut"), CampaignError);
  }
  const models = host.models.providers.fixture.models;
  models.push({ ...models[0], contextWindow: 2000000 });
  assert.throws(() => resolveHostContextWindow(host, "dut"), /budget-full-context-not-configured/);
  host.models.providers.fixture.models = {};
  assert.throws(() => resolveHostContextWindow(host, "dut"), /budget-full-context-not-configured/);
});

async function fixture(t, limits = vector(100, 1000, 100000000, 1000000), baselineUsage = {
  knownActual: vector(3, 7, 101, 11), retainedExposure: vector(1, 2, 103, 13),
}) {
  assert.ok(isAbsolute(harness));
  const directory = join(harness, `campaign-budget-${randomUUID()}`);
  const accountRoot = join(directory, "account");
  await mkdir(accountRoot, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { force: true, recursive: true }));
  const authorization = { version: 1, accountId: randomUUID(), accountRoot, limits };
  const baseline = { version: 1, accountId: authorization.accountId, verified: true,
    ...baselineUsage };
  const auth = await immutable(join(directory, "authorization.json"), authorization);
  const base = await immutable(join(directory, "baseline.json"), baseline);
  const config = { budget: { ...settings, accountRoot,
    authorizationPath: auth.path, authorizationSha256: auth.sha256,
    baselinePath: base.path, baselineSha256: base.sha256 } };
  const dependencies = { identify: async () => ({ pid: process.pid, startId: "synthetic" }),
    inspect: async () => "gone", planner: async () => new Map([[testCase.id, plan]]) };
  let ordinal = 0;
  async function controller(existing) {
    const campaignId = existing?.campaignId ?? randomUUID();
    const campaignRoot = existing?.campaignRoot ?? join(directory, `campaign-${ordinal++}`);
    if (!existing) {
      await mkdir(campaignRoot, { mode: 0o700 });
      await immutable(join(campaignRoot, "campaign.json"), { campaignId });
      await createJournal(campaignRoot);
    }
    const writer = await journalWriter(campaignRoot, randomUUID(), async () => {});
    const hook = () => ({ events: writer.rows(),
      append: (event, data) => writer.append(`budget.${event}`, data) });
    const factory = () => createCampaignPolicy({ campaignId, campaignRoot, config }, dependencies);
    const policy = await factory();
    await policy.preflight();
    const audit = () => policy.audit(hook());
    async function dispatch() {
      const id = randomUUID();
      const path = join(campaignRoot, id);
      await mkdir(path, { mode: 0o700 });
      const manifest = await immutable(join(path, "manifest.json"), { cases: [plan.testCase] });
      const scoped = await immutable(join(path, "scope.json"), plan.scope);
      const context = { campaignId, caseId: testCase.id, dispatchId: id,
        manifestPath: manifest.path, manifestSha256: manifest.sha256, scopePath: scoped.path,
        hashes: { [manifest.path]: manifest.sha256, [scoped.path]: scoped.sha256 } };
      const reserve = () => policy.reserve({ ...hook(), context, testCase: plan.testCase, scope: plan.scope });
      return { context, reserve, settle: (result) => policy.settle({ ...hook(), context, result }),
        retain: (result) => policy.retain({ ...hook(), context, result }) };
    }
    return { campaignId, campaignRoot, writer, hook, policy, audit, dispatch, factory };
  }
  return { directory, config, baseline, authorization, controller, dependencies };
}

function usage(v = vector()) {
  return { ...v, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, priced: false };
}
function section(v, caseId = testCase.id) {
  const observed = usage(v);
  return { status: "complete", totals: observed, completeUsage: observed, observedLowerBound: observed,
    cases: [{ caseId, status: "complete", executionSettled: true, aborted: false, observedLowerBound: observed,
      hardLimits: { status: "adapter-attested", attestation: { quiescent: true, hardLimitsVerified: true } } }] };
}
async function resultFor(f, dispatch, dut = vector(3, 3, 300, 30), review = vector(1, 1, 100, 10),
  configure = () => {}) {
  const accounting = { dut: section(dut), review: section(review) };
  configure(accounting);
  const proof = await immutable(join(f.directory, `report-${randomUUID()}.json`), {
    manifestSha256: dispatch.context.manifestSha256, cases: [{ id: testCase.id }], budgetAccounting: accounting });
  return { status: "settled", accountingComplete: true, quiescent: true, outcome: "passed",
    reportPath: proof.path, reportSha256: proof.sha256, accounting };
}

const maxVector = (left, right) => Object.fromEntries(Object.keys(left).map((key) =>
  [key, Math.max(left[key], right[key])]));
const poolVectors = (dut = vector(), review = vector()) => ({ dut, review });
const observedPoolTotal = (observed) => addAccount(observed.dut, observed.review);
const retainedPoolTotal = (observed, pools = plan.pools) => addAccount(
  maxVector(pools.dut, observed.dut), maxVector(pools.review, observed.review),
);
const reducerBinding = () => ({ accountId: "account", campaignId: "campaign", campaignRoot: "C:\\campaign" });
function reservedRow(binding, overrides = {}) {
  return { event: "budget.account-reserved", data: {
    accountId: binding.accountId, campaignId: binding.campaignId, caseId: testCase.id, dispatchId: "dispatch",
    manifestSha256: "a".repeat(64), scopeSha256: "b".repeat(64),
    amount: structuredClone(plan.reservation), pools: structuredClone(plan.pools), ...overrides,
  } };
}
function settlementRow(event, binding, poolObservedLowerBounds, overrides = {}) {
  const observedLowerBound = observedPoolTotal(poolObservedLowerBounds);
  return { event, data: {
    accountId: binding.accountId, campaignId: binding.campaignId, caseId: testCase.id, dispatchId: "dispatch",
    manifestSha256: "a".repeat(64), scopeSha256: "b".repeat(64), proofSha256: "c".repeat(64),
    knownActual: event === "budget.account-settled" ? observedLowerBound : vector(),
    observedLowerBound, poolObservedLowerBounds,
    retainedExposure: event === "budget.account-settled" ? vector() : retainedPoolTotal(poolObservedLowerBounds),
    ...overrides,
  } };
}

test("shared baseline is charged once across controllers and reservations survive restarts", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  assert.deepEqual((await a.audit()).committed, vector(4, 9, 204, 24));
  const d = await a.dispatch();
  assert.equal((await d.reserve()).admitted, true);
  assert.equal((await d.reserve()).admitted, true);
  assert.equal(a.writer.rows().filter((row) => row.event === "budget.account-reserved").length, 1);
  assert.equal((await a.audit()).safeToContinue, false);
  const resumed = await f.controller(a);
  assert.equal((await resumed.audit()).retainedExposure.inputTokens, 8000103);
  const other = await f.controller();
  const shared = await other.audit();
  assert.deepEqual(shared.knownActual, f.baseline.knownActual);
  assert.equal(shared.pending.length, 1);
  assert.equal(shared.retainedExposure.inputTokens, 8000103);
  assert.equal(shared.safeToContinue, true);
  const result = await resultFor(f, d);
  const settlement = await resumed.policy.settle({ ...resumed.hook(), context: d.context, result });
  assert.equal(settlement.settled, true);
  assert.deepEqual((await other.audit()).committed, vector(7, 13, 604, 64));
  await resumed.policy.settle({ ...resumed.hook(), context: d.context, result });
  assert.equal((await readJournal(a.campaignRoot)).filter((row) => row.event === "budget.account-settled").length, 1);
});

test("unknown zero, missing/cross-case/unsettled proof cannot release a reservation", { skip }, async (t) => {
  const f = await fixture(t);
  for (const kind of ["unknown", "missing", "cross-case", "unsettled", "wrong-report"]) {
    const a = await f.controller();
    await a.audit();
    const d = await a.dispatch();
    await d.reserve();
    const result = await resultFor(f, d, vector(), vector());
    if (kind === "unknown") Object.assign(result, { status: "unknown", accountingComplete: false });
    if (kind === "missing") delete result.accounting.review;
    if (kind === "cross-case") result.accounting.dut.cases[0].caseId = "other";
    if (kind === "unsettled") result.accounting.dut.cases[0].executionSettled = false;
    if (kind === "wrong-report") result.reportSha256 = "0".repeat(64);
    assert.equal((await d.settle(result)).settled, false, kind);
    assert.equal((await d.settle(result)).settled, false, kind);
    const rows = await readJournal(a.campaignRoot);
    const bound = rows.find((row) => row.event === "budget.account-bound").data;
    const r = reduceBudgetJournal(rows, bound).reservations.get(d.context.dispatchId);
    assert.deepEqual(r.retainedExposure, plan.reservation, kind);
    assert.deepEqual(r.knownActual, vector(), kind);
    assert.equal(rows.filter((row) => row.event === "budget.account-unknown").length, 1);
  }
});

test("unknown DUT and reviewer lower bounds are both retained, including observed overage", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await d.reserve();
  const result = await resultFor(f, d, vector(1, 10, 3000000, 10), vector(1, 25, 9000000, 10));
  result.accounting.dut.pending = true;
  result.status = "unknown";
  const settled = await d.settle(result);
  assert.equal(settled.settled, false);
  assert.equal(settled.observedLowerBound.inputTokens, 12000000);
  assert.equal(settled.observedLowerBound.userTurns, 1);
  assert.equal(settled.retainedExposure.userTurns, 3);
  assert.equal(settled.retainedExposure.inputTokens, 15000000);
  assert.equal(settled.retainedExposure.modelRequests, 49);
  assert.equal(settled.knownActual.inputTokens, 0);
});

test("incomplete settlement retains symmetric per-pool overage on DUT and reviewer sides", { skip }, async (t) => {
  for (const [name, dut, review, retained] of [
    ["dut", vector(1, 5, 9000000, 10), vector(), 11000000],
    ["review", vector(), vector(0, 9, 9000000, 10), 15000000],
  ]) {
    const f = await fixture(t);
    const a = await f.controller();
    await a.audit();
    const d = await a.dispatch();
    await d.reserve();
    const settled = await d.retain(await resultFor(f, d, dut, review));
    assert.equal(settled.settled, false, name);
    assert.equal(settled.observedLowerBound.inputTokens, 9000000, name);
    assert.equal(settled.retainedExposure.inputTokens, retained, name);
    assert.deepEqual(settled.poolObservedLowerBounds, { dut, review });
  }
});

test("per-pool incomplete exposure blocks competing reservations that aggregate-only accounting would admit", { skip }, async (t) => {
  const f = await fixture(t, vector(100, 1000, 17000000, 1000000),
    { knownActual: vector(), retainedExposure: vector() });
  const a = await f.controller();
  const b = await f.controller();
  await a.audit();
  await b.audit();
  const d = await a.dispatch();
  await d.reserve();
  const settled = await d.retain(await resultFor(f, d, vector(1, 1, 9000000, 10), vector()));
  assert.equal(settled.retainedExposure.inputTokens, 11000000);
  assert.equal((await (await f.controller(a)).audit()).committed.inputTokens, 11000000);
  const competing = await b.dispatch();
  const denied = await competing.reserve();
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, "authorization-exhausted");
  assert.equal(b.writer.rows().some((row) => row.event === "budget.account-reserved"), false);
});

test("alternating pool observations survive restart and accumulate monotonically per pool", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await d.reserve();
  const first = await d.retain(await resultFor(f, d, vector(1, 1, 9000000, 10), vector()));
  assert.equal(first.retainedExposure.inputTokens, 11000000);
  const resumed = await f.controller(a);
  const second = await resumed.policy.retain({ ...resumed.hook(), context: d.context,
    result: await resultFor(f, d, vector(), vector(1, 1, 9000000, 10)) });
  assert.equal(second.observedLowerBound.inputTokens, 18000000);
  assert.equal(second.retainedExposure.inputTokens, 18000000);
  assert.deepEqual(second.poolObservedLowerBounds,
    poolVectors(vector(1, 1, 9000000, 10), vector(0, 1, 9000000, 10)));
  assert.equal((await (await f.controller()).audit()).retainedExposure.inputTokens, 18000103);
});

test("shared turns count only DUT inputs while both pools charge physical requests and input/cache/output", { skip }, async (t) => {
  const f = await fixture(t, vector(7, 1000, 100000000, 1000000));
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  assert.equal((await d.reserve()).admitted, true);
  const result = await resultFor(f, d, vector(3, 5, 100, 10), vector(1, 2, 200, 20), (accounting) => {
    Object.assign(accounting.dut.observedLowerBound, { cacheReadTokens: 30, cacheWriteTokens: 40 });
    Object.assign(accounting.review.observedLowerBound, { cacheReadTokens: 50, cacheWriteTokens: 60 });
  });
  const settled = await d.settle(result);
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.knownActual, vector(3, 7, 480, 30));
  assert.deepEqual(settled.observedLowerBound, settled.knownActual);
  assert.deepEqual((await a.audit()).committed, vector(7, 16, 684, 54));
});

test("malformed proof sections retain other identity-bound observations instead of throwing untyped errors", { skip }, async (t) => {
  const f = await fixture(t);
  for (const malformed of [null, [], {}, { cases: null }, { cases: [null] },
    { cases: [{ caseId: testCase.id }], observedLowerBound: { userTurns: "1" } },
    { cases: [{ caseId: "other" }], observedLowerBound: usage(vector(1, 1, Number.MAX_SAFE_INTEGER)) }]) {
    const a = await f.controller();
    await a.audit();
    const d = await a.dispatch();
    await d.reserve();
    const result = await resultFor(f, d, vector(), vector(1, 2, 9000000, 4));
    result.accounting.dut = malformed;
    const settled = await d.settle(result);
    assert.equal(settled.settled, false);
    assert.deepEqual(settled.observedLowerBound, vector(0, 2, 9000000, 4));
    assert.equal(settled.retainedExposure.inputTokens, 15000000);
    assert.equal(settled.retainedExposure.userTurns, 3);
  }
});

test("reduceBudgetJournal fails closed on malformed pool reservations and pool evidence tampering", async (t) => {
  const binding = reducerBinding();
  const observed = poolVectors(vector(1, 5, 9000000, 10), vector());
  for (const [name, rows, code] of [
    ["reservation-pool-totals", [{ event: "budget.account-bound", data: binding },
      reservedRow(binding, { pools: { ...structuredClone(plan.pools),
        review: { ...plan.pools.review, inputTokens: plan.pools.review.inputTokens - 1 } } })],
    "budget-reservation-pools-invalid"],
    ["missing-reservation-pools", [{ event: "budget.account-bound", data: binding },
      reservedRow(binding, { pools: undefined })], "budget-reservation-pools-invalid"],
    ["review-turns", [{ event: "budget.account-bound", data: binding },
      reservedRow(binding, { pools: { dut: { ...plan.pools.dut, userTurns: 2 },
        review: { ...plan.pools.review, userTurns: 1 } } })], "budget-reservation-pools-invalid"],
    ["missing-pool-evidence", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed, { poolObservedLowerBounds: { dut: observed.dut } })],
    "budget-pool-accounting-corrupt"],
    ["legacy-aggregate-only", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed, { poolObservedLowerBounds: undefined })],
    "budget-pool-accounting-corrupt"],
    ["aggregate-mismatch", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed, { observedLowerBound: vector() })],
    "budget-pool-accounting-corrupt"],
    ["aggregate-only-retention", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed,
        { retainedExposure: maxVector(plan.reservation, observedPoolTotal(observed)) })],
    "budget-exposure-released"],
    ["replacement-pools", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed, { pools: poolVectors() })],
    "budget-settlement-identity"],
    ["replacement-amount", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed, { amount: vector() })],
    "budget-settlement-identity"],
    ["decreased-pool-evidence", [{ event: "budget.account-bound", data: binding }, reservedRow(binding),
      settlementRow("budget.account-unknown", binding, observed),
      settlementRow("budget.account-unknown", binding, poolVectors(vector(1, 5, 6000000, 10), vector(0, 1, 9000000, 10)))],
    "budget-exposure-released"],
  ]) {
    await t.test(name, () => {
      assert.throws(() => reduceBudgetJournal(rows, binding), { name: "CampaignError", code });
    });
  }
});

test("completed settlements cannot release previously observed per-pool lower bounds", () => {
  const binding = reducerBinding();
  const rows = [
    { event: "budget.account-bound", data: binding },
    reservedRow(binding),
    settlementRow("budget.account-unknown", binding,
      poolVectors(vector(3, 24, 9000000, 24000), vector(0, 8, 2000000, 8000))),
    settlementRow("budget.account-settled", binding,
      poolVectors(vector(3, 24, 6000000, 24000), vector(0, 8, 9000000, 8000))),
  ];
  assert.throws(() => reduceBudgetJournal(rows, binding),
    { name: "CampaignError", code: "budget-exposure-released" });
});

test("contradictory complete proof retains both prior and new pool observations across restart", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await d.reserve();
  await d.retain(await resultFor(f, d, vector(1, 1, 9000000, 10), vector()));
  const result = await resultFor(f, d, vector(), vector(1, 1, 9000000, 10));
  const retained = await d.settle(result);
  assert.equal(retained.settled, false);
  assert.equal(retained.observedLowerBound.inputTokens, 18000000);
  assert.equal(retained.retainedExposure.inputTokens, 18000000);
  assert.deepEqual(retained.knownActual, vector());
  assert.equal((await (await f.controller(a)).audit()).retainedExposure.inputTokens, 18000103);
});

test("accounting overflow is a durable fatal latch across audit, restart and competing admission", { skip }, async (t) => {
  for (const kind of ["input-cache", "pool-input", "pool-requests", "pool-output", "unsafe-counter"]) {
    const f = await fixture(t);
    const a = await f.controller();
    const b = await f.controller();
    await a.audit();
    await b.audit();
    const d = await a.dispatch();
    await d.reserve();
    const result = await resultFor(f, d);
    const dut = result.accounting.dut.observedLowerBound;
    const review = result.accounting.review.observedLowerBound;
    if (kind === "input-cache") Object.assign(dut, { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1 });
    if (kind === "pool-input") dut.inputTokens = Number.MAX_SAFE_INTEGER;
    if (kind === "pool-requests") dut.modelRequests = Number.MAX_SAFE_INTEGER;
    if (kind === "pool-output") review.outputTokens = Number.MAX_SAFE_INTEGER;
    if (kind === "unsafe-counter") review.inputTokens = Number.MAX_SAFE_INTEGER + 1;
    result.status = "unknown";
    const fatal = { name: "CampaignError", code: "budget-accounting-overflow" };
    await assert.rejects(d.settle(result), fatal, kind);
    const rows = await readJournal(a.campaignRoot);
    const latch = rows.find((row) => row.event === "budget.account-fatal");
    assert.equal(latch.data.dispatchId, d.context.dispatchId, kind);
    assert.equal(latch.data.reason, "budget-accounting-overflow");
    assert.ok(!rows.some((row) => ["budget.account-unknown", "budget.account-settled"].includes(row.event)));
    await assert.rejects(a.audit(), fatal);
    await assert.rejects((await f.controller(a)).audit(), fatal);
    await assert.rejects(b.audit(), fatal);
    await assert.rejects((await b.dispatch()).reserve(), fatal);
    await assert.rejects(d.settle(await resultFor(f, d)), fatal);
    assert.equal((await readJournal(a.campaignRoot)).filter((row) => row.event === "budget.account-fatal").length, 1);
  }
});

test("per-pool retained maxima overflow also latches the account fatally", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  const b = await f.controller();
  await a.audit();
  await b.audit();
  const d = await a.dispatch();
  await d.reserve();
  const fatal = { name: "CampaignError", code: "budget-accounting-overflow" };
  await assert.rejects(d.retain(await resultFor(f, d, vector(1, 1, Number.MAX_SAFE_INTEGER, 10), vector())), fatal);
  assert.equal((await readJournal(a.campaignRoot)).filter((row) => row.event === "budget.account-fatal").length, 1);
  await assert.rejects(a.audit(), fatal);
  await assert.rejects((await f.controller(a)).audit(), fatal);
  await assert.rejects((await b.dispatch()).reserve(), fatal);
});

test("unexpected accounting errors propagate instead of becoming incomplete usage", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await d.reserve();
  const result = await resultFor(f, d);
  Object.defineProperty(result.accounting.dut.cases[0], "caseId", {
    enumerable: false, get: () => { throw new TypeError("unexpected proof access"); },
  });
  await assert.rejects(d.settle(result), { name: "TypeError", message: "unexpected proof access" });
  assert.ok(!(await readJournal(a.campaignRoot)).some((row) => row.event === "budget.account-unknown"));
});

test("settlement records actual overage without clamping and stops further admission", { skip }, async (t) => {
  const f = await fixture(t, vector(100, 1000, 9000000, 1000000));
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await d.reserve();
  const result = await resultFor(f, d, vector(3, 25, 10000000, 40000));
  assert.equal((await d.settle(result)).settled, true);
  const audit = await a.audit();
  assert.equal(audit.knownActual.inputTokens, 10000201);
  assert.equal(audit.overage.inputTokens, 1000304);
  assert.equal(audit.safeToContinue, false);
  const another = await a.dispatch();
  assert.equal((await another.reserve()).admitted, false);
});

test("baseline SHA, verification, counter presence and authorization/account binding fail closed", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  for (const change of [{ baselineSha256: "0".repeat(64) }, { accountRoot: f.directory }]) {
    await assert.rejects(readBudgetAuthorization({ ...f.config.budget, ...change }));
  }
  const original = await readFile(f.config.budget.baselinePath);
  for (const patch of [{ verified: false }, { knownActual: null }, { retainedExposure: {} },
    { accountId: "other" }]) {
    const bytes = JSON.stringify({ ...f.baseline, ...patch });
    await writeFile(f.config.budget.baselinePath, bytes);
    await assert.rejects(readBudgetAuthorization({ ...f.config.budget, baselineSha256: hash(bytes) }));
  }
  await writeFile(f.config.budget.baselinePath, original);
  const next = await immutable(join(f.directory, "replacement.json"), { ...f.baseline, knownActual: vector() });
  await assert.rejects(createCampaignPolicy({ campaignId: a.campaignId, campaignRoot: a.campaignRoot,
    config: { budget: { ...f.config.budget, baselinePath: next.path, baselineSha256: next.sha256 } } },
  f.dependencies), /budget-account-rebinding/);
});

test("malformed baseline and authorization files fail with typed validation errors", { skip }, async (t) => {
  const f = await fixture(t);
  for (const [name, original, code] of [
    ["baseline", f.baseline, "unverified-budget-baseline"],
    ["authorization", f.authorization, "invalid-budget-authorization"],
  ]) {
    const path = f.config.budget[`${name}Path`];
    for (const bytes of ["{broken", "null", "[]", "true", "1", '""']) {
      await writeFile(path, bytes);
      await assert.rejects(readBudgetAuthorization({ ...f.config.budget, [`${name}Sha256`]: hash(bytes) }),
        { name: "CampaignError", code }, `${name}: ${bytes}`);
    }
    await writeFile(path, `${JSON.stringify(original)}\n`);
  }
  for (const field of ["knownActual", "retainedExposure"]) {
    for (const value of [undefined, null, [], {}, "", { ...vector(), userTurns: null },
      { ...vector(), modelRequests: -1 }, { ...vector(), inputTokens: "0" },
      { ...vector(), outputTokens: 0.5 }, { ...vector(), inputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
      const bytes = JSON.stringify({ ...f.baseline, [field]: value });
      await writeFile(f.config.budget.baselinePath, bytes);
      await assert.rejects(readBudgetAuthorization({ ...f.config.budget, baselineSha256: hash(bytes) }),
        (error) => error instanceof CampaignError && error.code === "invalid-account-vector");
    }
  }
  const bytes = JSON.stringify({ ...f.baseline, knownActual: vector(0, 0, Number.MAX_SAFE_INTEGER),
    retainedExposure: vector(0, 0, 1) });
  await writeFile(f.config.budget.baselinePath, bytes);
  await assert.rejects(readBudgetAuthorization({ ...f.config.budget, baselineSha256: hash(bytes) }),
    { name: "CampaignError", code: "budget-accounting-overflow" });
});

test("reservation fsync failure and torn journal cannot grant admission or reset exposure", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await assert.rejects(a.policy.reserve({ ...a.hook(), context: d.context,
    testCase: plan.testCase, scope: plan.scope,
    append: async (event, data) => { await a.writer.append(`budget.${event}`, data); throw new Error("after-fsync"); } }),
  /after-fsync/);
  assert.equal((await (await f.controller()).audit()).retainedExposure.inputTokens, 8000103);
  await writeFile(join(a.campaignRoot, "controller.jsonl"), "{torn", { flag: "a" });
  await assert.rejects((await f.controller()).audit(), /journal-torn/);
});

test("wall clock regression never expires durable reservations", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await f.controller();
  await a.audit();
  const d = await a.dispatch();
  await d.reserve();
  const now = Date.now;
  try {
    Date.now = () => 1;
    const audit = await (await f.controller(a)).audit();
    assert.equal(audit.retainedExposure.inputTokens, 8000103);
    assert.equal(audit.safeToContinue, false);
  } finally { Date.now = now; }
});

test("concurrent controllers cannot both acquire the shared authorization lock", { skip }, async (t) => {
  const f = await fixture(t);
  f.dependencies.inspect = async () => "alive";
  const a = await f.controller();
  const b = await f.controller();
  const outcomes = await Promise.allSettled([a.audit(), b.audit()]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.match(outcomes.find((item) => item.status === "rejected").reason.code, /budget-account-busy/);
});

test("default production policy preflights actual configured caps offline and reserves before executor", { skip }, async (t) => {
  await import("../scripts/run-acceptance.mjs");
  const f = await fixture(t);
  const sourceRoot = resolve(".");
  const oracles = await immutable(join(f.directory, "oracles.json"),
    { suiteId: "budget-offline", cases: { multi: {} } });
  const manifest = await immutable(join(f.directory, "manifest.json"), {
    suiteId: "budget-offline", cases: [testCase],
    corpusOracle: { sha256: oracles.sha256, caseCount: 1 } });
  const host = await immutable(join(f.directory, "host.json"), {
    agents: { defaults: { model: { primary: "fixture/model" } },
      entries: { dut: { model: { fallbacks: ["fixture/fallback"] } }, reviewer: { model: "fixture/reviewer" } } },
    models: { providers: { fixture: { models: [
      { id: "model", contextWindow: 1400000 },
      { id: "fallback", contextWindow: 1600000 },
      { id: "reviewer", contextWindow: 1200000 },
    ] } } },
    plugins: { entries: { "dsh-native": { config: { operationalBudget: attempt } } } },
  });
  const gateway = await immutable(join(f.directory, "gateway.json"), { agentMap: { dut: "dut" } });
  const reviewer = await immutable(join(f.directory, "reviewer.json"), { agentId: "reviewer" });
  const scoped = await immutable(join(f.directory, "scope.json"), scope);
  const config = { ...f.config, version: 1, sourceRoot, campaignRoot: join(f.directory, "production"),
    runner: join(sourceRoot, "scripts", "run-acceptance.mjs"), node: process.execPath,
    adapter: join(sourceRoot, "scripts", "lib", "gateway-acceptance-adapter.mjs"),
    reviewer: join(sourceRoot, "scripts", "lib", "gateway-corpus-reviewer.mjs"),
    manifest: manifest.path, oracles: oracles.path, scope: scoped.path, caseIds: ["multi"], live: false,
    env: { OPENCLAW_CONFIG_PATH: host.path, DSH_ACCEPTANCE_GATEWAY_CONFIG: gateway.path,
      DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG: reviewer.path },
    pins: {}, heartbeatMs: 1000, runnerTimeoutMs: 500000,
    health: { url: "http://127.0.0.1:1/ready", headers: {}, totalWaitMs: 1000, requestTimeoutMs: 50,
      initialBackoffMs: 1, maxBackoffMs: 2 } };
  for (const path of [config.runner, config.node, config.adapter, config.reviewer,
    config.manifest, config.oracles, config.scope, ...Object.values(config.env),
    config.budget.authorizationPath, config.budget.baselinePath]) {
    config.pins[path] = hash(await readFile(path));
  }
  const small = await immutable(join(f.directory, "small-scope.json"), {
    ...scope, attemptBudget: { ...attempt, maxInputTokens: 1000000 },
  });
  const tooSmall = { ...config, campaignRoot: join(f.directory, "rejected"), scope: small.path,
    pins: { ...config.pins, [small.path]: small.sha256 } };
  const rejected = await immutable(join(f.directory, "rejected-config.json"), tooSmall);
  await assert.rejects(prepareCampaign(rejected.path), /Configured maxInputTokens.*exceeds/);
  for (const [name, contextWindow] of [["oversized-fallback", 2000001], ["missing-fallback", undefined]]) {
    const value = JSON.parse(await readFile(host.path, "utf8"));
    value.models.providers.fixture.models.find((model) => model.id === "fallback").contextWindow = contextWindow;
    const changed = await immutable(join(f.directory, `${name}-host.json`), value);
    const invalid = await immutable(join(f.directory, `${name}-config.json`), {
      ...config, campaignRoot: join(f.directory, name),
      env: { ...config.env, OPENCLAW_CONFIG_PATH: changed.path },
      pins: { ...config.pins, [changed.path]: changed.sha256 },
    });
    await assert.rejects(prepareCampaign(invalid.path),
      contextWindow ? /full prepared contextWindow/ : /budget-full-context-not-configured/);
  }
  const saved = await immutable(join(f.directory, "production-config.json"), config);
  await prepareCampaign(saved.path);
  let probes = 0;
  let dispatches = 0;
  let elapsed = 0;
  const result = await runCampaign(config.campaignRoot, {
    identify: async (pid) => ({ pid, startId: "offline-controller" }), inspect: async () => "gone",
    health: { now: () => elapsed, delay: async (ms) => { elapsed += ms; },
      probe: async () => { probes++; return true; } },
    executor: { execute: async (context, { onStarted }) => {
      dispatches++;
      const events = await readJournal(config.campaignRoot);
      const reserved = events.find((row) => row.event === "budget.account-reserved");
      assert.deepEqual(reserved.data.amount, plan.reservation);
      const prepared = JSON.parse(await readFile(context.manifestPath, "utf8"));
      assert.equal(prepared.cases[0].limits.usage.userTurns, 3);
      assert.equal(prepared.cases[0].limits.usage.modelRequests, 24);
      await onStarted({ pid: 1234, startId: "synthetic-child" });
      return { status: "unknown", accountingComplete: false, quiescent: false, reason: "test-only" };
    } },
  });
  assert.equal(result.status, "paused", JSON.stringify(result));
  assert.equal(probes, 3);
  assert.equal(dispatches, 1);
  const events = await readJournal(config.campaignRoot);
  assert.ok(events.findIndex((row) => row.event === "case-prepared") <
    events.findIndex((row) => row.event === "health-wait-started"));
  assert.ok(events.some((row) => row.event === "budget.account-unknown"));
});
