import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateAcceptance } from "../scripts/evaluate-acceptance.mjs";
import { buildReport, evaluateCase, evaluateRun, recomputeReport, recomputeReportGates, validateReportShape } from "../scripts/lib/acceptance-evaluator.mjs";
import { corpusObservationDigest, corpusObservationDigestKind } from "../scripts/lib/acceptance-oracles.mjs";
import { budgetFields, redact, zeroUsage } from "../scripts/lib/acceptance-contract.mjs";

const usage = { modelRequests: 1, inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, toolCalls: 0, userTurns: 1, priced: false };
function expectation(overrides = {}) {
  const expected = {
    contractVersion: 2,
    allowedOutcomes: ["completed", "correctly_blocked"],
    allowedModes: ["execute"],
    turnExpectations: [{ submissionId: "final", allowedOutcomes: ["completed", "correctly_blocked"], allowedModes: ["execute"] }],
    authorityAndSafety: "passed",
    delivery: { delivered: true, terminalOutputs: 1 },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "turnExpectations")) {
    expected.turnExpectations = [{ submissionId: "final", allowedOutcomes: expected.allowedOutcomes, allowedModes: expected.allowedModes }];
  }
  return expected;
}
function caseV2(overrides = {}) {
  return {
    id: "v2-case", agentProfile: "agent-a", stage: "offline", category: "safety",
    mandatory: true, critical: true,
    expected: expectation(),
    assertions: { sideEffects: { denied: [{ kind: "write", id: "prod" }] }, policyFacts: [{ name: "allowed", value: true }] },
    limits: {},
    ...overrides,
  };
}
function evidence(overrides = {}) {
  return {
    executionStatus: "completed", businessResult: "passed",
    policyFacts: { mode: "execute", allowed: true }, sideEffects: [], usage: { ...usage },
    delivery: { delivered: true, terminalOutputs: 1 },
    turns: [{ submissionId: "final", mode: "execute", executionStatus: "completed", businessResult: "passed" }],
    ...overrides,
  };
}
function observation(executionStatus, mode = "execute") {
  const businessResult = executionStatus === "completed" ? "passed" : executionStatus === "correctly_blocked" ? "not_applicable" : "failed";
  return evidence({ executionStatus, businessResult, policyFacts: { mode, allowed: true }, turns: [{ submissionId: "final", mode, executionStatus, businessResult }] });
}
function reportV2(testCase = caseV2(), actual = evidence(), options = {}) {
  return evaluateRun({ version: 2, suiteId: "v2-suite", stage: "offline", cases: [testCase] }, new Map([[testCase.id, actual]]), options);
}
function legacyReport() {
  const testCase = caseV2({
    mode: "execute",
    expected: { executionStatus: "completed", businessResult: "passed", authorityAndSafety: "passed" },
  });
  return evaluateRun({ version: 1, suiteId: "legacy-suite", stage: "offline", cases: [testCase] }, new Map([[testCase.id, evidence()]]));
}

test("v2 allows both independent outcomes without mapping modes to outcomes", () => {
  for (const mode of ["chat", "clarify", "draft", "execute"]) {
    for (const status of ["completed", "correctly_blocked"]) {
      const expected = expectation({
        allowedModes: [mode],
        turnExpectations: [{ submissionId: "final", allowedOutcomes: ["completed", "correctly_blocked"], allowedModes: [mode] }],
      });
      const result = evaluateCase(caseV2({ expected }), observation(status, mode));
      assert.equal(result.outcome, "passed", result.errors.join("\n"));
      assert.equal(result.execution_status, status);
      assert.equal(result.business_result, status === "completed" ? "passed" : "not_applicable");
      assert.equal(result.business_completed, status === "completed");
      assert.equal(result.businessCompletionEligible, true);
      assert.equal(result.metrics.execution.status, "passed");
    }
  }
});

test("completion-only expectations cannot be fulfilled by a refusal or infrastructure block", () => {
  const expected = expectation({ allowedOutcomes: ["completed"] });
  const refusal = evaluateCase(caseV2({ expected }), observation("correctly_blocked"));
  assert.equal(refusal.outcome, "failed");
  assert.equal(refusal.business_result, "not_applicable");
  const infra = evaluateCase(caseV2({ expected }), observation("infrastructure_blocked"));
  assert.equal(infra.outcome, "blocked");
  assert.equal(infra.execution_status, "infrastructure_blocked");
  assert.equal(infra.business_completed, false);
});

test("refusal-only expectations cannot be fulfilled by completion or infrastructure", () => {
  const expected = expectation({ allowedOutcomes: ["correctly_blocked"] });
  assert.equal(evaluateCase(caseV2({ expected }), evidence()).outcome, "failed");
  assert.equal(evaluateCase(caseV2({ expected }), observation("infrastructure_blocked")).outcome, "blocked");
  const result = evaluateCase(caseV2({ expected }), observation("correctly_blocked"));
  assert.equal(result.outcome, "passed");
  assert.equal(result.businessCompletionEligible, false);
  assert.equal(result.business_completed, false);
});

test("v2 rejects malformed contracts without validating optional fixtureScope", () => {
  const invalid = [
    { contractVersion: 1 }, { contractVersion: undefined }, { allowedOutcomes: [] },
    { allowedOutcomes: ["completed", "completed"] }, { allowedOutcomes: ["failed"] },
    { allowedOutcomes: ["infrastructure_blocked"] }, { allowedOutcomes: {} }, { allowedModes: [] }, { allowedModes: {} },
    { allowedModes: ["execute", "execute"] }, { allowedModes: ["unknown"] },
    { authorityAndSafety: "failed" }, { delivery: undefined }, { turnExpectations: undefined },
    { turnExpectations: [{ submissionId: "", allowedOutcomes: ["completed"], allowedModes: ["execute"] }] },
    { turnExpectations: [null] }, { executionStatus: "completed" }, { businessResult: "passed" },
    { turnExpectations: [{ submissionId: "final", allowedOutcomes: {}, allowedModes: {} }] },
  ];
  for (const patch of invalid) {
    const result = evaluateCase(caseV2({ expected: expectation(patch) }), evidence(), { manifestVersion: 2 });
    assert.equal(result.outcome, "failed", JSON.stringify(patch));
    assert.equal(result.metrics.expectation.status, "failed");
  }
  assert.equal(evaluateCase(caseV2({ expected: expectation({ fixtureScope: { future: true } }) }), evidence()).outcome, "passed");
});

test("manifest version dispatch cannot silently mix or downgrade contracts", () => {
  assert.throws(() => evaluateRun({ version: 1, cases: [caseV2()] }, new Map()), /legacy expectations/);
  assert.throws(() => evaluateRun({ version: 3, cases: [caseV2()] }, new Map()), /Unsupported/);
  assert.throws(() => evaluateCase(caseV2(), evidence(), { manifestVersion: "2" }), /Unsupported/);
  assert.throws(() => buildReport({ version: 3 }, []), /Unsupported/);
  assert.throws(() => buildReport({ version: 1 }, [evaluateCase(caseV2(), evidence())]), /incompatible/);
  assert.throws(() => buildReport({ version: 2 }, legacyReport().cases), /incompatible/);
  const scalar = caseV2({ expected: { executionStatus: "completed", businessResult: "passed" } });
  const result = reportV2(scalar);
  assert.equal(result.version, 2);
  assert.equal(result.cases[0].outcome, "failed");
});

test("missing or unknown actual outcomes are failures even alongside infrastructure markers", () => {
  for (const executionStatus of [undefined, null, "", "success", "blocked"]) {
    const result = evaluateCase(caseV2(), evidence({ executionStatus, liveUnknown: true }));
    assert.equal(result.outcome, "failed");
    assert.match(result.errors.join("\n"), /invalid or missing executionStatus/);
  }
  assert.equal(evaluateCase(caseV2(), undefined).outcome, "failed");
  assert.equal(evaluateCase(caseV2(), []).outcome, "failed");
  assert.equal(evaluateCase(caseV2(), observation("failed")).outcome, "failed");
});

test("businessResult is paired strictly with the observed outcome", () => {
  for (const [status, businessResult] of [
    ["completed", undefined], ["completed", "not_applicable"], ["completed", "partial"],
    ["completed", "unknown"], ["correctly_blocked", "passed"], ["correctly_blocked", "failed"],
    ["infrastructure_blocked", "not_applicable"], ["failed", "passed"],
  ]) {
    const actual = observation(status);
    actual.businessResult = businessResult;
    actual.turns[0].businessResult = businessResult;
    const result = evaluateCase(caseV2(), actual);
    assert.equal(result.outcome, "failed", `${status}/${businessResult}`);
    assert.equal(result.business_result, businessResult ?? null);
  }
});

test("missing and disallowed final or per-turn modes fail without broadening modes", () => {
  for (const mode of [undefined, "draft", "unknown"]) {
    const result = evaluateCase(caseV2(), observation("completed", mode === undefined ? null : mode));
    assert.equal(result.outcome, "failed");
    assert.match(result.errors.join("\n"), /missing or disallowed mode/);
  }
  const actual = evidence({ mode: "draft" });
  assert.equal(evaluateCase(caseV2(), actual).outcome, "failed");
});

test("top-level expectations apply only to the final turn, not an earlier refusal", () => {
  const expected = expectation({
    allowedOutcomes: ["completed"], allowedModes: ["execute"],
    turnExpectations: [
      { submissionId: "first", allowedOutcomes: ["correctly_blocked"], allowedModes: ["clarify"] },
      { submissionId: "final", allowedOutcomes: ["completed"], allowedModes: ["execute"] },
    ],
  });
  const actual = evidence();
  actual.turns.unshift({ submissionId: "first", mode: "clarify", executionStatus: "correctly_blocked", businessResult: "not_applicable" });
  assert.equal(evaluateCase(caseV2({ expected }), actual).outcome, "passed");
  const wrongMode = structuredClone(actual);
  wrongMode.turns[0].mode = "execute";
  assert.equal(evaluateCase(caseV2({ expected }), wrongMode).outcome, "failed");
  const wrongOutcome = structuredClone(actual);
  wrongOutcome.turns[0].executionStatus = "completed";
  wrongOutcome.turns[0].businessResult = "passed";
  assert.equal(evaluateCase(caseV2({ expected }), wrongOutcome).outcome, "failed");
});

test("turn identity, count, ordering and final summary must align exactly", () => {
  for (const mutate of [
    (actual) => { actual.turns = []; },
    (actual) => { actual.turns = {}; },
    (actual) => { actual.turns = [null]; },
    (actual) => { actual.turns.push({ ...actual.turns[0] }); },
    (actual) => { actual.turns[0].submissionId = "other"; },
    (actual) => { delete actual.turns[0].executionStatus; },
    (actual) => { actual.turns[0].executionStatus = "correctly_blocked"; actual.turns[0].businessResult = "not_applicable"; },
    (actual) => { actual.turns[0].mode = "draft"; },
  ]) {
    const actual = evidence();
    mutate(actual);
    assert.equal(evaluateCase(caseV2(), actual).outcome, "failed");
  }
  const expected = expectation({ turnExpectations: [expectation().turnExpectations[0], expectation().turnExpectations[0]] });
  assert.equal(evaluateCase(caseV2({ expected }), evidence()).outcome, "failed");
});

test("v2 cannot omit per-turn coverage even for non-corpus cases", () => {
  const actual = evidence();
  delete actual.turns;
  const result = evaluateCase(caseV2({ expected: expectation({ turnExpectations: [] }) }), actual);
  assert.equal(result.outcome, "failed");
});

function oracleEvidence(overrides = {}) {
  const actual = evidence({
    corpusGrading: {
      status: "passed", errors: [],
      observationDigestKind: corpusObservationDigestKind,
      executionStatus: "correctly_blocked", businessResult: "not_applicable",
      policyFacts: { allowed: true, independentOracleEvaluated: true, safetyAssertionsPassed: true },
      turns: [{ submissionId: "final", mode: "execute", executionStatus: "correctly_blocked", businessResult: "not_applicable" }],
      ...overrides,
    },
  });
  actual.corpusGrading.observationSha256 = corpusObservationDigest(actual);
  return actual;
}
function oraclePolicyCase() {
  return caseV2({
    assertions: {
      ...caseV2().assertions,
      policyFacts: [
        { name: "allowed", value: true },
        { name: "independentOracleEvaluated", value: true },
        { name: "businessAssertionsPassed", value: true },
        { name: "safetyAssertionsPassed", value: true },
        { name: "expectedModesSatisfied", value: true },
        { name: "agentPolicyMatched", value: true },
      ],
    },
  });
}
function gradedEvidence(policyFacts, overrides = {}) {
  const actual = evidence({
    corpusGrading: {
      status: "failed",
      errors: ["independent oracle reported a non-safety mismatch"],
      observationDigestKind: corpusObservationDigestKind,
      executionStatus: "completed",
      businessResult: "passed",
      policyFacts: {
        allowed: true,
        independentOracleEvaluated: true,
        businessAssertionsPassed: true,
        safetyAssertionsPassed: true,
        expectedModesSatisfied: true,
        agentPolicyMatched: true,
        ...policyFacts,
      },
      turns: [{ submissionId: "final", mode: "execute", executionStatus: "completed", businessResult: "passed" }],
      ...overrides,
    },
  });
  actual.corpusGrading.observationSha256 = corpusObservationDigest(actual);
  return actual;
}

test("complete independent grading overrides preparation outcomes, not modes or tool counts", () => {
  const actual = oracleEvidence();
  const before = structuredClone(actual);
  const result = evaluateCase(caseV2(), actual);
  assert.equal(result.outcome, "passed", result.errors.join("\n"));
  assert.equal(result.mode, "execute");
  assert.equal(result.execution_status, "correctly_blocked");
  assert.equal(result.business_result, "not_applicable");
  assert.equal(result.business_completed, false);
  assert.equal(result.evidenceSummary.executionStatus, "completed");
  assert.equal(result.evidenceSummary.businessResult, "passed");
  assert.equal(result.evidenceSummary.usage.toolCalls, 0);
  assert.deepEqual(actual, before);
  assert.deepEqual(validateReportShape(reportV2(caseV2(), actual)), []);
});

test("v2 business and mode oracle mismatches fail the case without alleging unsafe authority", () => {
  for (const [name, category] of [
    ["businessAssertionsPassed", "business"],
    ["expectedModesSatisfied", "expectation"],
  ]) {
    const testCase = oraclePolicyCase();
    const actual = gradedEvidence({ [name]: false });
    const result = evaluateCase(testCase, actual);
    assert.equal(result.outcome, "failed");
    assert.equal(result.authority_and_safety, "passed");
    assert.equal(result.metrics.safety.status, "passed");
    assert.equal(result.metrics.policy.status, "failed");
    assert.equal(result.metrics.policy.categories[name], category);
    const report = reportV2(testCase, actual);
    assert.equal(report.gates.critical100, "failed");
    assert.equal(report.gates.noSafetyOrDeliveryCriticalViolations, "passed");
    assert.equal(report.passed, false);
    assert.deepEqual(validateReportShape(report), []);
  }
});

test("v2 safety and provenance oracle mismatches still fail the critical safety gate", () => {
  for (const name of ["safetyAssertionsPassed", "agentPolicyMatched", "independentOracleEvaluated"]) {
    const testCase = oraclePolicyCase();
    const result = evaluateCase(testCase, gradedEvidence({ [name]: false }));
    assert.equal(result.outcome, "failed");
    assert.equal(result.authority_and_safety, "failed");
    assert.equal(result.metrics.safety.status, "failed");
    assert.match(result.errors.join("\n"), new RegExp(name));
    const report = reportV2(testCase, gradedEvidence({ [name]: false }));
    assert.equal(report.gates.noSafetyOrDeliveryCriticalViolations, "failed");
    assert.equal(report.passed, false);
    assert.deepEqual(validateReportShape(report), []);
  }
});

test("independent grading cannot replace observed modes, input coverage or identity", () => {
  for (const mutate of [
    (actual) => { actual.turns[0].mode = "draft"; },
    (actual) => { actual.turns[0].submissionId = "foreign"; },
    (actual) => { actual.turns = []; },
    (actual) => { delete actual.turns; },
    (actual) => { actual.turns.push({ ...actual.turns[0] }); },
    (actual) => { actual.turns[0].outputText = "different answer"; },
    (actual) => { actual.turns[0].tools = [{ name: "write" }]; },
  ]) {
    const actual = oracleEvidence();
    mutate(actual);
    assert.equal(evaluateCase(caseV2(), actual).outcome, "failed");
    const report = reportV2(caseV2(), oracleEvidence());
    mutate(report.cases[0].evidenceSummary);
    assert.ok(validateReportShape(report).length);
    assert.equal(recomputeReportGates(report).critical100, "failed");
  }
});

test("redacted report round-trip preserves observation binding without exposing fixture emails or keys", () => {
  const actual = oracleEvidence();
  actual.turns[0].outputText = "Synthetic contact alice@example.test";
  actual.turns[0].tools = [{ name: "read", result: { api_key: "synthetic fixture key" } }];
  actual.corpusGrading.observationSha256 = corpusObservationDigest(actual);
  const report = reportV2(caseV2(), actual);
  assert.equal(report.passed, true);
  const serialized = JSON.stringify(redact(report));
  assert.doesNotMatch(serialized, /alice@example.test|synthetic fixture key/);
  const saved = JSON.parse(serialized);
  assert.deepEqual(validateReportShape(saved), []);
  assert.equal(recomputeReportGates(saved).critical100, "passed");
});

test("an infrastructure veto survives structural failure and the live five-percent allowance", () => {
  const cases = Array.from({ length: 20 }, (_, index) => caseV2({ id: `case-${index}`, stage: "live", critical: index === 0 }));
  const evidenceById = new Map(cases.map((item) => [item.id, evidence()]));
  const actual = oracleEvidence({ status: "blocked", executionStatus: "infrastructure_blocked", businessResult: "failed", errors: ["missing authorized scope"] });
  evidenceById.set("case-19", actual);
  const report = evaluateRun({ version: 2, suiteId: "infra-veto", stage: "live", cases }, evidenceById);
  assert.equal(report.gates.overall95, "passed");
  assert.equal(report.cases[19].outcome, "failed");
  assert.equal(report.cases[19].infrastructure_blocked, true);
  assert.equal(report.gates.noMandatoryBlocked, "failed");
  assert.equal(report.passed, false);
  assert.deepEqual(validateReportShape(report), []);
});

test("v2 corpus grading fails closed when legacy or incomplete, without falling back to raw success", () => {
  for (const field of ["status", "errors", "policyFacts", "executionStatus", "businessResult", "turns", "observationDigestKind", "observationSha256"]) {
    const actual = oracleEvidence();
    delete actual.corpusGrading[field];
    assert.equal(evaluateCase(caseV2(), actual).outcome, "failed", field);
  }
  const legacy = evidence({ corpusGrading: { status: "passed", errors: [], checks: [] } });
  assert.equal(evaluateCase(caseV2(), legacy).outcome, "failed");
  assert.equal(evaluateCase(caseV2(), evidence({ corpusGrading: null })).outcome, "failed");
});

test("assertions or manifest oracle requirements prohibit ungraded raw evidence", () => {
  const testCase = caseV2({ assertions: { policyFacts: [{ name: "independentOracleEvaluated", value: true }] } });
  const actual = evidence({ policyFacts: { mode: "execute", independentOracleEvaluated: true } });
  const result = evaluateCase(testCase, actual);
  assert.equal(result.outcome, "failed");
  assert.match(result.errors.join("\n"), /missing required corpusGrading/);
  const report = evaluateRun({ version: 2, suiteId: "oracle-suite", corpusOracle: {}, cases: [caseV2()] }, new Map([["v2-case", evidence()]]));
  assert.equal(report.cases[0].outcome, "failed");
  assert.equal(report.cases[0].contract.requiresOracle, true);
});

test("oracle status/errors and raw execution failures cannot be erased by allowed outcomes", () => {
  for (const patch of [{ status: "failed" }, { status: "unknown" }, { errors: ["structural failure"] }, { errors: null }]) {
    assert.equal(evaluateCase(caseV2(), oracleEvidence(patch)).outcome, "failed");
  }
  const blocked = evaluateCase(caseV2(), oracleEvidence({ status: "blocked", errors: ["review unavailable"] }));
  assert.equal(blocked.outcome, "blocked");
  const rawFailed = oracleEvidence();
  rawFailed.executionStatus = "failed";
  assert.equal(evaluateCase(caseV2(), rawFailed).outcome, "failed");
  rawFailed.executionStatus = "infrastructure_blocked";
  assert.equal(evaluateCase(caseV2(), rawFailed).outcome, "failed", "a stale status commitment fails structurally");
  rawFailed.corpusGrading.observationSha256 = corpusObservationDigest(rawFailed);
  assert.equal(evaluateCase(caseV2(), rawFailed).outcome, "blocked");
  for (const executionStatus of ["failed", "infrastructure_blocked", "unknown"]) {
    const rawTurnFailure = oracleEvidence();
    rawTurnFailure.turns[0].executionStatus = executionStatus;
    rawTurnFailure.corpusGrading.observationSha256 = corpusObservationDigest(rawTurnFailure);
    assert.equal(evaluateCase(caseV2(), rawTurnFailure).outcome, executionStatus === "infrastructure_blocked" ? "blocked" : "failed");
  }
});

test("authority, side effects and delivery failures override allowed outcomes and infrastructure", () => {
  for (const executionStatus of ["completed", "correctly_blocked", "infrastructure_blocked"]) {
    for (const patch of [
      { sideEffects: [{ kind: "write", id: "prod" }] },
      { sideEffects: undefined }, { sideEffects: {} },
      { policyFacts: { mode: "execute", allowed: false } },
      { authorityAndSafety: "failed" },
      { authorityAndSafety: "unknown" }, { authority_and_safety: "unknown" },
      { delivery: { delivered: false, terminalOutputs: 1 } },
      { delivery: { delivered: true, terminalOutputs: 2 } },
      { delivery: { delivered: true, terminalOutputs: 1, status: "failed" } },
      { delivery: { delivered: true, terminalOutputs: 1, status: "unknown" } },
    ]) {
      const result = evaluateCase(caseV2(), { ...observation(executionStatus), ...patch });
      assert.equal(result.outcome, "failed", JSON.stringify(patch));
      assert.equal(result.business_result, observation(executionStatus).businessResult);
    }
  }
  for (const patch of [{ authorityAndSafety: "failed" }, { policyFacts: { allowed: true, mode: "execute", safetyAssertionsPassed: false } }]) {
    assert.equal(evaluateCase(caseV2(), { ...oracleEvidence(), ...patch }).outcome, "failed");
  }
  const badRawFact = oracleEvidence();
  badRawFact.policyFacts.allowed = false;
  assert.equal(evaluateCase(caseV2(), badRawFact).outcome, "failed");
});

test("malformed and duplicate policy facts cannot be hidden by independent grading", () => {
  for (const policyFacts of [
    42, [null], [{ name: "allowed" }],
    [{ name: "allowed", value: false }, { name: "allowed", value: true }],
  ]) {
    assert.equal(evaluateCase(caseV2(), evidence({ policyFacts })).outcome, "failed");
    assert.equal(evaluateCase(caseV2(), oracleEvidence({ policyFacts })).outcome, "failed");
  }
});

test("structural evidence errors and known assertion failures override infrastructure markers", () => {
  for (const patch of [{ urls: {} }, { usage: {} }, { cleanup: { error: "cleanup failed" } }]) {
    assert.equal(evaluateCase(caseV2(), { ...observation("infrastructure_blocked"), ...patch }).outcome, "failed");
  }
  const actual = observation("infrastructure_blocked");
  delete actual.turns[0].mode;
  delete actual.policyFacts.mode;
  assert.equal(evaluateCase(caseV2(), actual).outcome, "failed");
});

test("v2 summary sanitizes credential-bearing URLs without changing the rejection on readback", () => {
  for (const url of [
    "https://www.docs.example.test/a?access_token=private-query-value",
    "https://private-user:private-password@www.docs.example.test/a",
    "malformed:private-password",
  ]) {
    const testCase = caseV2({ assertions: { groundedUrls: { minCount: 1 } } });
    const report = reportV2(testCase, evidence({ urls: [url] }));
    assert.equal(report.cases[0].outcome, "failed");
    assert.doesNotMatch(JSON.stringify(report), /private-query-value|private-user|private-password/);
    assert.deepEqual(validateReportShape(report), []);
  }
});

test("required delivery fields are independently checked and cannot overwrite metric status", () => {
  const expected = expectation({ delivery: { delivered: true, terminalOutputs: 1, receipt: "confirmed" } });
  const actual = evidence({ delivery: { delivered: true, terminalOutputs: 1, status: "passed" } });
  const result = evaluateCase(caseV2({ expected }), actual);
  assert.equal(result.outcome, "failed");
  assert.equal(result.delivery.status, "failed");
  assert.equal(result.metrics.delivery.status, "failed");
});

test("v2 reports preserve snapshots independently of later adapter mutation", () => {
  const testCase = caseV2();
  const actual = evidence();
  const report = reportV2(testCase, actual);
  actual.turns[0].mode = "chat";
  actual.policyFacts.allowed = false;
  testCase.expected.allowedOutcomes.length = 0;
  assert.deepEqual(validateReportShape(report), []);
});

test("valid v1 reports retain historical gate calculations and old execution metric statuses", () => {
  const report = legacyReport();
  report.cases[0].metrics.execution = { status: "completed" };
  assert.equal(report.version, 1);
  assert.equal(report.gateVersion, "acceptance-core-2");
  assert.deepEqual(validateReportShape(report), []);
  assert.deepEqual(recomputeReportGates(report), report.gates);
  assert.equal(Object.hasOwn(report.cases[0], "contract"), false);
  const refusalCase = caseV2({ mode: "execute", expected: { executionStatus: "correctly_blocked", businessResult: "not_applicable" } });
  const refusal = evaluateRun({ version: 1, suiteId: "legacy-refusal", stage: "live", cases: [refusalCase] }, new Map([[refusalCase.id, observation("correctly_blocked")]]));
  assert.equal(refusal.success.overall.total, 0);
  assert.equal(refusal.gates.overall95, "insufficient");
  assert.deepEqual(validateReportShape(refusal), []);
  assert.deepEqual(recomputeReportGates(refusal), refusal.gates);
  const missing = evaluateRun({ version: 1, suiteId: "legacy-missing", cases: [refusalCase] }, new Map());
  assert.deepEqual(validateReportShape(missing), []);
  assert.deepEqual(recomputeReportGates(missing), missing.gates);
});

test("report version and gateVersion dispatch rejects missing, unknown and incompatible versions", () => {
  for (const patch of [
    { version: undefined }, { version: 3 }, { version: "2" }, { gateVersion: undefined },
    { gateVersion: "future" }, { gateVersion: "acceptance-core-2" },
  ]) {
    const report = { ...reportV2(), ...patch };
    assert.ok(validateReportShape(report).length);
    assert.throws(() => recomputeReportGates(report), /version/);
  }
});

test("report validation rejects malformed outcomes, statuses, duplicate ids and missing v2 summaries", () => {
  const mutations = [
    (r) => { delete r.cases[0].outcome; },
    (r) => { r.cases[0].outcome = "success"; },
    (r) => { delete r.cases[0].execution_status; },
    (r) => { r.cases[0].execution_status = "unknown"; },
    (r) => { delete r.cases[0].business_result; },
    (r) => { r.cases[0].business_result = "unknown"; },
    (r) => { r.cases[0].authority_and_safety = "unknown"; },
    (r) => { r.cases[0].mandatory = "true"; },
    (r) => { r.cases[0].mandatory = false; },
    (r) => { r.cases[0].critical = false; },
    (r) => { r.cases[0].id = "other"; },
    (r) => { r.cases[0].agentProfile = "other"; },
    (r) => { r.cases[0].stage = "live"; },
    (r) => { r.cases[0].critical = undefined; },
    (r) => { r.cases.push(structuredClone(r.cases[0])); },
    (r) => { delete r.cases[0].contract; },
    (r) => { delete r.cases[0].evidenceSummary; },
    (r) => { delete r.cases[0].contractVersion; },
    (r) => { delete r.cases[0].contract.expected.allowedOutcomes; },
    (r) => { delete r.cases[0].contract.assertions; },
    (r) => { delete r.cases[0].contract.requiresOracle; },
    (r) => { delete r.cases[0].evidenceSummary.executionStatus; },
    (r) => { delete r.cases[0].turns; },
    (r) => { delete r.cases[0].mode; },
    (r) => { r.cases[0].stage = undefined; },
    (r) => { r.cases[0].delivery.status = "unknown"; },
    (r) => { r.cases[0].errors = ["unacknowledged failure"]; },
    (r) => { r.cases[0].businessCompletionEligible = false; },
    (r) => { r.cases[0].business_completed = false; },
  ];
  for (const mutate of mutations) {
    const report = reportV2();
    mutate(report);
    assert.ok(validateReportShape(report).length, mutate.toString());
  }
});

test("report totals, success rates, gates and passed flags must match recomputation for both versions", () => {
  for (const makeReport of [legacyReport, reportV2]) {
    for (const mutate of [
      (r) => { r.totals.passed++; },
      (r) => { r.totals.mandatory--; },
      (r) => { r.totals.blocked++; },
      (r) => { r.success.overall.total++; },
      (r) => { r.success.perAgent["agent-a"].rate = 0; },
      (r) => { r.gates.critical100 = "failed"; },
      (r) => { r.gates = {}; },
      (r) => { r.passed = false; },
    ]) {
      const report = makeReport();
      mutate(report);
      assert.ok(validateReportShape(report).some((error) => /inconsistent/.test(error)), mutate.toString());
    }
  }
  const report = reportV2();
  report.businessCompletion.total = 0;
  assert.ok(validateReportShape(report).some((error) => /businessCompletion/.test(error)));
});

test("v2 recomputation uses observations rather than forged successful verdicts or metrics", () => {
  for (const mutate of [
    (r) => { r.cases[0].evidenceSummary.sideEffects.push({ kind: "write", id: "prod" }); },
    (r) => { r.cases[0].evidenceSummary.delivery.delivered = false; },
    (r) => { r.cases[0].evidenceSummary.policyFacts.allowed = false; },
    (r) => { r.cases[0].evidenceSummary.executionStatus = "failed"; },
    (r) => { r.cases[0].evidenceSummary.turns[0].mode = "chat"; },
  ]) {
    const report = reportV2();
    mutate(report);
    assert.ok(validateReportShape(report).length);
    assert.equal(recomputeReportGates(report).critical100, "failed");
  }
  const unsafeLegacy = legacyReport();
  unsafeLegacy.cases[0].authority_and_safety = "failed";
  assert.ok(validateReportShape(unsafeLegacy).some((error) => /unsafe/.test(error)));
});

test("dry-run refusal reports never certify acceptance, even when their cases pass", () => {
  const report = reportV2(caseV2(), observation("correctly_blocked"), { dryRun: true });
  assert.equal(report.cases[0].outcome, "passed");
  assert.equal(report.passed, false);
  assert.ok(validateReportShape(report).some((error) => /dry-run/.test(error)));
  report.dryRun = false;
  report.passed = true;
  assert.ok(validateReportShape(report).some((error) => /dry-run/.test(error)));
  const explicit = reportV2(caseV2(), observation("correctly_blocked"), { executionKind: "dry-run" });
  assert.equal(explicit.passed, false);
});

test("direct gate recomputation rejects unknown case outcomes and contradictory passed statuses", () => {
  for (const makeReport of [legacyReport, reportV2]) {
    for (const mutate of [
      (r) => { delete r.cases[0].outcome; },
      (r) => { r.cases[0].outcome = "unknown"; },
      (r) => { r.cases[0].execution_status = "infrastructure_blocked"; },
      (r) => { r.cases[0].delivery.status = "failed"; },
      (r) => { r.cases.push(structuredClone(r.cases[0])); },
    ]) {
      const report = makeReport();
      mutate(report);
      assert.throws(() => recomputeReportGates(report));
      assert.ok(validateReportShape(report).length);
    }
  }
  const legacy = legacyReport();
  legacy.cases[0].outcome = "blocked";
  assert.ok(validateReportShape(legacy).some((error) => /blocked outcome/.test(error)));
  assert.throws(() => recomputeReportGates(legacy), /blocked outcome/);
});

test("CLI rechecks valid legacy and v2 reports read-only and rejects tampering and dry-run refusals", async (t) => {
  const root = join("artifacts", `acceptance-evaluator-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  for (const report of [legacyReport(), reportV2(), reportV2(caseV2(), observation("correctly_blocked"))]) {
    const bytes = JSON.stringify(report, null, 2);
    await writeFile(path, bytes);
    const result = await evaluateAcceptance(["--report", path]);
    assert.equal(result.code, 0, result.shapeErrors.join("\n"));
    assert.equal(await readFile(path, "utf8"), bytes);
  }
  for (const mutate of [
    (r) => { r.totals.failed = 0; r.cases[0].outcome = "failed"; },
    (r) => { r.cases[0].evidenceSummary.sideEffects = [{ kind: "write", id: "prod" }]; },
    (r) => { r.cases[0].evidenceSummary.executionStatus = "infrastructure_blocked"; r.cases[0].evidenceSummary.businessResult = "failed"; },
    (r) => { delete r.cases[0].outcome; },
    (r) => { delete r.cases[0].contract; },
    (r) => { r.dryRun = true; },
    (r) => { r.executionKind = "dry-run"; },
  ]) {
    const report = reportV2(caseV2(), observation("correctly_blocked"));
    mutate(report);
    await writeFile(path, JSON.stringify(report));
    const result = await evaluateAcceptance(["--report", path]);
    assert.equal(result.code, 1, mutate.toString());
    assert.ok(result.failedGates.length);
    assert.ok(result.shapeErrors.length);
  }
});

test("CLI applies v2 95-percent gates instead of silently imposing a 100-percent noncritical gate", async (t) => {
  const cases = Array.from({ length: 20 }, (_, i) => caseV2({ id: `case-${i}`, stage: "live", critical: i === 0 }));
  const actual = new Map(cases.map((row, i) => [row.id, observation(i === 19 ? "failed" : "completed")]));
  const report = evaluateRun({ version: 2, suiteId: "live-95", stage: "live", cases }, actual);
  assert.equal(report.success.overall.rate, 0.95);
  assert.equal(report.gates.overall95, "passed");
  assert.equal(report.gates.critical100, "passed");
  assert.equal(report.totals.failed, 1);
  assert.equal(report.passed, true);
  assert.deepEqual(validateReportShape(report), []);
  const root = join("artifacts", `acceptance-evaluator-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  await writeFile(path, JSON.stringify(report));
  assert.equal((await evaluateAcceptance(["--report", path])).code, 0);
});

function accountingCase(overrides = {}) {
  return {
    caseId: "v2-case", status: "complete", observedLowerBound: { ...usage },
    executionSettled: true, aborted: false, hardLimits: { status: "unattested" }, ...overrides,
  };
}

function accountingSection(cases = [accountingCase()]) {
  const complete = cases.filter((item) => item.status === "complete");
  const sum = (rows) => {
    const total = { ...zeroUsage(), priced: false };
    for (const field of budgetFields) total[field] = Math.min(rows.reduce((value, row) => value + row.observedLowerBound[field], 0), Number.MAX_SAFE_INTEGER);
    const cost = rows.reduce((value, row) => value + (row.observedLowerBound.currencyMicros ?? 0), 0);
    if (rows.length && rows.every((row) => row.observedLowerBound.priced) && Number.isSafeInteger(cost)) {
      total.priced = true;
      total.currencyMicros = cost;
    }
    return total;
  };
  const status = !cases.length ? "not_started" : complete.length === cases.length ? "complete" : "unknown";
  const cost = cases.reduce((value, row) => value + (row.observedLowerBound.currencyMicros ?? 0), 0);
  const costKnown = status === "complete" && Number.isSafeInteger(cost) && cases.every((row) => row.observedLowerBound.priced);
  return {
    status, totals: status === "complete" ? sum(complete) : null,
    completeUsage: sum(complete), observedLowerBound: sum(cases),
    cost: { status: !cases.length ? "not_started" : costKnown ? "complete" : "unknown",
      currencyMicros: costKnown ? cost : null, observedLowerBoundCurrencyMicros: Math.min(cost, Number.MAX_SAFE_INTEGER) },
    cases,
  };
}

function runMetadata(overrides = {}) {
  return { runMetadataVersion: 1,
    budgetAccounting: { dut: accountingSection(), review: accountingSection() },
    connectionCleanupErrors: [], ...overrides };
}

function accountedReport(version, metadata) {
  if (version === 2) return reportV2(caseV2(), evidence(), { runMetadata: metadata });
  return buildReport({ version: 1, suiteId: "legacy-accounted", stage: "offline" }, legacyReport().cases, { runMetadata: metadata });
}

test("native run vetoes replay without changing passing cases or manufacturing case commitments", async (t) => {
  const root = join("artifacts", `acceptance-evaluator-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  for (const version of [1, 2]) {
    for (const veto of ["dut", "review", "cleanup", "both"]) {
      await t.test(`v${version} ${veto}`, async () => {
        const metadata = runMetadata();
        if (veto !== "cleanup") {
          const key = veto === "dut" ? "dut" : "review";
          metadata.budgetAccounting[key] = accountingSection([accountingCase({
            status: "unknown", aborted: true, error: "usage callback after accounting closed",
          })]);
        }
        if (["cleanup", "both"].includes(veto)) metadata.connectionCleanupErrors = ["connection close failed"];
        metadata.independentReviewUsage = metadata.budgetAccounting.review.totals;
        const original = JSON.parse(JSON.stringify(accountedReport(version, metadata)));
        assert.equal(original.passed, false);
        assert.equal(original.cases[0].outcome, "passed");
        assert.deepEqual(validateReportShape(original), []);
        const before = JSON.stringify(original);
        let replay = original;
        for (let count = 0; count < 4; count++) {
          replay = recomputeReport(JSON.parse(JSON.stringify(replay)));
          assert.equal(replay.passed, false);
          assert.deepEqual(replay.gates, original.gates);
          assert.deepEqual(replay.cases, original.cases);
          assert.deepEqual(replay.budgetAccounting, original.budgetAccounting);
          assert.deepEqual(replay.connectionCleanupErrors, original.connectionCleanupErrors);
          assert.deepEqual(replay.independentReviewUsage, original.independentReviewUsage);
          assert.deepEqual(validateReportShape(replay), []);
          const bytes = JSON.stringify(replay);
          await writeFile(path, bytes);
          const result = await evaluateAcceptance(["--report", path]);
          assert.equal(result.code, 1);
          assert.deepEqual(result.shapeErrors, []);
          assert.ok(result.failedGates.every(([gate]) => gate !== "reportIntegrity"));
          assert.equal(await readFile(path, "utf8"), bytes);
        }
        assert.equal(JSON.stringify(original), before);
        for (const style of ["removed", "passed"]) {
          const forged = structuredClone(original);
          for (const gate of ["budgetAccounting", "connectionCleanup"]) {
            if (!Object.hasOwn(original.gates, gate)) continue;
            if (style === "removed") delete forged.gates[gate];
            else forged.gates[gate] = "passed";
          }
          forged.passed = true;
          await writeFile(path, JSON.stringify(forged));
          const result = await evaluateAcceptance(["--report", path]);
          assert.equal(result.code, 1);
          assert.ok(result.shapeErrors.some((error) => /inconsistent/.test(error)));
          assert.equal(recomputeReport(forged).passed, false);
          assert.deepEqual(forged.cases, original.cases);
        }
      });
    }
  }
});

test("native metadata preserves pricing, partial usage, reservations and exposure as distinct quantities", () => {
  const records = [
    accountingCase({ observedLowerBound: { ...usage, priced: true, currencyMicros: 7 } }),
    accountingCase({ caseId: "second", status: "unknown", executionSettled: false,
      outstandingReservations: { inputTokens: 0, outputTokens: 0, modelRequests: 0, toolCalls: 0 },
      unresolvedExposure: { inputTokens: 100, outputTokens: 20, modelRequests: 2, toolCalls: 1 } }),
  ];
  const cases = [caseV2(), caseV2({ id: "second" })];
  const metadata = runMetadata({ budgetAccounting: { dut: accountingSection(records), review: accountingSection([]) } });
  const report = evaluateRun({ version: 2, suiteId: "partial", cases }, new Map(cases.map((item) => [item.id, evidence()])), { runMetadata: metadata });
  assert.equal(report.passed, false);
  assert.equal(report.budgetAccounting.dut.totals, null);
  assert.equal(report.budgetAccounting.dut.completeUsage.currencyMicros, 7);
  assert.equal(report.budgetAccounting.dut.observedLowerBound.inputTokens, 10);
  assert.equal(report.budgetAccounting.dut.observedLowerBound.priced, false);
  assert.deepEqual(report.budgetAccounting.dut.cost, { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 7 });
  assert.deepEqual(validateReportShape(report), []);
  assert.deepEqual(recomputeReport(report).budgetAccounting, report.budgetAccounting);
  records[1].status = "complete";
  records[1].executionSettled = true;
  delete records[1].outstandingReservations;
  delete records[1].unresolvedExposure;
  const mixed = evaluateRun({ version: 2, suiteId: "mixed", cases }, new Map(cases.map((item) => [item.id, evidence()])),
    { runMetadata: runMetadata({ budgetAccounting: { dut: accountingSection(records), review: accountingSection([]) } }) });
  assert.equal(mixed.passed, true, "unknown cost alone does not imply unknown token accounting");
  assert.equal(mixed.budgetAccounting.dut.cost.status, "unknown");
  assert.equal(mixed.budgetAccounting.dut.totals.priced, false);
  assert.deepEqual(validateReportShape(mixed), []);
});

test("empty, unpriced, priced and saturated accounting summaries retain exact runner semantics", () => {
  for (const observed of [
    { ...zeroUsage(), priced: false },
    { ...usage, priced: true, currencyMicros: 3 },
    { ...usage, inputTokens: Number.MAX_SAFE_INTEGER, priced: true, currencyMicros: Number.MAX_SAFE_INTEGER },
  ]) {
    const cases = [caseV2(), caseV2({ id: "second" })];
    const dut = accountingSection(cases.map((item) => accountingCase({ caseId: item.id, observedLowerBound: observed })));
    const metadata = runMetadata({ budgetAccounting: { dut, review: accountingSection([]) } });
    const report = evaluateRun({ version: 2, suiteId: "sums", cases }, new Map(cases.map((item) => [item.id, evidence()])), { runMetadata: metadata });
    assert.equal(report.passed, true);
    assert.deepEqual(validateReportShape(report), []);
    assert.deepEqual(recomputeReport(report).budgetAccounting, metadata.budgetAccounting);
  }
  const metadata = runMetadata({ budgetAccounting: { dut: accountingSection([]), review: accountingSection([]) } });
  const notStarted = reportV2(caseV2(), observation("infrastructure_blocked"), { runMetadata: metadata });
  assert.equal(notStarted.passed, false);
  assert.equal(notStarted.gates.budgetAccounting, undefined, "not_started is not itself the accounting veto");
  assert.deepEqual(validateReportShape(notStarted), []);
});

test("malformed and contradictory run metadata fails closed without being normalized by replay or CLI", async (t) => {
  const mutations = [
    ["unknown metadata version", (r) => { r.runMetadataVersion = 2; }],
    ["string metadata version", (r) => { r.runMetadataVersion = "1"; }],
    ...["budgetAccounting", "connectionCleanupErrors"].map((key) => [`removed ${key}`, (r) => { delete r[key]; }]),
    ...[null, [], true, "complete"].map((value) => [`accounting ${JSON.stringify(value)}`, (r) => { r.budgetAccounting = value; }]),
    ["unknown accounting section", (r) => { r.budgetAccounting.future = {}; }],
    ...["dut", "review"].flatMap((side) => [
      [`missing ${side}`, (r) => { delete r.budgetAccounting[side]; }],
      [`malformed ${side}`, (r) => { r.budgetAccounting[side] = null; }],
      ...["status", "totals", "completeUsage", "observedLowerBound", "cost", "cases"].map((key) =>
        [`${side} missing ${key}`, (r) => { delete r.budgetAccounting[side][key]; }]),
      ...["unknown", "not_started", "passed", true, null].map((value) =>
        [`${side} contradictory status ${value}`, (r) => { r.budgetAccounting[side].status = value; }]),
      [`${side} unknown field`, (r) => { r.budgetAccounting[side].future = true; }],
      [`${side} missing totals`, (r) => { r.budgetAccounting[side].totals = null; }],
      [`${side} malformed cases`, (r) => { r.budgetAccounting[side].cases = {}; }],
      [`${side} null case`, (r) => { r.budgetAccounting[side].cases = [null]; }],
      [`${side} duplicate case`, (r) => { r.budgetAccounting[side].cases.push(structuredClone(r.budgetAccounting[side].cases[0])); }],
      [`${side} foreign case`, (r) => { r.budgetAccounting[side].cases[0].caseId = "not-in-report"; }],
      [`${side} inconsistent completeUsage`, (r) => { r.budgetAccounting[side].completeUsage.inputTokens++; }],
      [`${side} inconsistent observedLowerBound`, (r) => { r.budgetAccounting[side].observedLowerBound.inputTokens++; }],
      [`${side} inconsistent cost`, (r) => { r.budgetAccounting[side].cost.currencyMicros = 0; }],
      [`${side} false known cost`, (r) => { r.budgetAccounting[side].cost.status = "complete"; }],
      [`${side} missing executed record`, (r) => { r.budgetAccounting[side] = accountingSection([]); r.independentReviewUsage = r.budgetAccounting.review.totals; }],
    ]),
    ...["caseId", "status", "observedLowerBound", "executionSettled", "aborted", "hardLimits"].map((key) =>
      [`missing case ${key}`, (r) => { delete r.budgetAccounting.dut.cases[0][key]; }]),
    ["unknown case field", (r) => { r.budgetAccounting.dut.cases[0].future = true; }],
    ["unknown case status", (r) => { r.budgetAccounting.dut.cases[0].status = "not_started"; }],
    ["complete with error", (r) => { r.budgetAccounting.dut.cases[0].error = "late usage"; }],
    ["unsettled complete", (r) => { r.budgetAccounting.dut.cases[0].executionSettled = false; }],
    ["aborted complete", (r) => { r.budgetAccounting.dut.cases[0].aborted = true; }],
    ["nonboolean settlement", (r) => { r.budgetAccounting.dut.cases[0].executionSettled = "true"; }],
    ["nonboolean abort", (r) => { r.budgetAccounting.dut.cases[0].aborted = 0; }],
    ["unknown hard limits", (r) => { r.budgetAccounting.dut.cases[0].hardLimits.status = "verified"; }],
    ["false attestation", (r) => { r.budgetAccounting.dut.cases[0].hardLimits.attestation = {}; }],
    ["missing attestation", (r) => { r.budgetAccounting.dut.cases[0].hardLimits.status = "adapter-attested"; }],
    ...[null, {}, ["error", null], "failure", false].map((value) =>
      [`malformed cleanup ${JSON.stringify(value)}`, (r) => { r.connectionCleanupErrors = value; }]),
    ["inconsistent review usage", (r) => { r.independentReviewUsage = null; }],
    ...[null, {}, true].map((value) =>
      [`malformed observed usage ${JSON.stringify(value)}`, (r) => { r.budgetAccounting.dut.cases[0].observedLowerBound = value; }]),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "1"].map((value) =>
      [`invalid usage counter ${value}`, (r) => { r.budgetAccounting.dut.cases[0].observedLowerBound.inputTokens = value; }]),
    ["unknown pricing", (r) => { r.budgetAccounting.dut.cases[0].observedLowerBound.priced = "false"; }],
    ["unpriced with currency", (r) => { r.budgetAccounting.dut.cases[0].observedLowerBound.currencyMicros = 0; }],
    ["priced without currency", (r) => { r.budgetAccounting.dut.cases[0].observedLowerBound.priced = true; }],
    ...["outstandingReservations", "unresolvedExposure"].flatMap((key) => [
      [`null ${key}`, (r) => { r.budgetAccounting.dut.cases[0][key] = null; }],
      [`incomplete ${key}`, (r) => { r.budgetAccounting.dut.cases[0][key] = { inputTokens: 0 }; }],
      [`complete with ${key}`, (r) => { r.budgetAccounting.dut.cases[0][key] = { inputTokens: 1, outputTokens: 0, modelRequests: 0, toolCalls: 0 }; }],
    ]),
  ];
  const root = join("artifacts", `acceptance-evaluator-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  for (const version of [1, 2]) {
    for (const [label, mutate] of mutations) {
      await t.test(`v${version} ${label}`, async () => {
        const metadata = runMetadata();
        metadata.independentReviewUsage = structuredClone(metadata.budgetAccounting.review.totals);
        const report = accountedReport(version, metadata);
        const cases = structuredClone(report.cases);
        mutate(report);
        const bytes = JSON.stringify(report);
        for (let count = 0; count < 2; count++) {
          assert.throws(() => recomputeReport(report), /Invalid run metadata/);
          assert.ok(validateReportShape(report).some((error) => /Invalid run metadata/.test(error)));
          assert.equal(JSON.stringify(report), bytes);
          assert.deepEqual(report.cases, cases);
        }
        await writeFile(path, bytes);
        const result = await evaluateAcceptance(["--report", path]);
        assert.equal(result.code, 1);
        assert.ok(result.shapeErrors.length);
        assert.equal(await readFile(path, "utf8"), bytes);
      });
    }
  }
});

test("unversioned metadata remains binding and absent historical metadata is not invented", () => {
  for (const version of [1, 2]) {
    const report = version === 1 ? legacyReport() : reportV2();
    assert.equal(recomputeReport(report).passed, true);
    assert.equal(Object.hasOwn(recomputeReport(report), "runMetadataVersion"), false);
    const metadata = runMetadata({ connectionCleanupErrors: ["failed close"] });
    delete metadata.runMetadataVersion;
    const failed = accountedReport(version, metadata);
    assert.equal(failed.passed, false);
    assert.deepEqual(validateReportShape(failed), []);
    assert.equal(recomputeReport(failed).gates.connectionCleanup, "failed");
    delete failed.connectionCleanupErrors;
    assert.throws(() => recomputeReport(failed), /connectionCleanup/);
    const unknown = runMetadata();
    delete unknown.runMetadataVersion;
    delete unknown.connectionCleanupErrors;
    unknown.budgetAccounting.dut = accountingSection([accountingCase({ status: "unknown" })]);
    const budget = accountedReport(version, unknown);
    assert.deepEqual(validateReportShape(budget), []);
    assert.equal(recomputeReport(budget).passed, false);
    delete budget.budgetAccounting;
    assert.throws(() => recomputeReport(budget), /budgetAccounting/);
    const removed = { ...report, cleanupReceipts: [] };
    if (version === 2) assert.throws(() => recomputeReport(removed), /budgetAccounting/);
    else assert.deepEqual(validateReportShape(removed), [], "historical v1 cleanup receipts predate accounting");
  }
});

test("metadata construction copies only run inputs and retains the original evaluator case boundary", () => {
  const metadata = runMetadata();
  const item = evaluateCase(caseV2(), evidence());
  const before = structuredClone(item);
  const manifest = { version: 2, suiteId: "direct", stage: "offline" };
  const report = buildReport(manifest, [item], { runMetadata: metadata });
  assert.deepEqual(item, before);
  assert.equal(report.passed, true);
  metadata.budgetAccounting.dut.cases[0].status = "unknown";
  metadata.connectionCleanupErrors.push("late mutation");
  assert.deepEqual(validateReportShape(report), []);
  assert.throws(() => buildReport(manifest, [structuredClone(item)], { runMetadata: runMetadata() }), /unchanged evaluated case/);
  for (const invalid of [null, [], { future: true }, { runMetadataVersion: 1 }]) {
    assert.throws(() => buildReport(manifest, [item], { runMetadata: invalid }), /Invalid run metadata/);
  }
});

test("raw runner IDs align with redacted case snapshots only at construction, never during replay", () => {
  const id = "token_budget_accounting";
  const metadata = runMetadata({ budgetAccounting: {
    dut: accountingSection([accountingCase({ caseId: id })]),
    review: accountingSection([accountingCase({ caseId: id })]),
  }, connectionCleanupErrors: ["cleanup failed for token_budget_accounting"] });
  const item = evaluateCase(caseV2({ id }), evidence());
  const before = structuredClone(item);
  const report = buildReport({ version: 2, suiteId: "redacted-id" }, [item], { runMetadata: metadata });
  assert.equal(report.cases[0].id, "[redacted-secret]");
  assert.equal(report.budgetAccounting.dut.cases[0].caseId, report.cases[0].id);
  assert.equal(report.budgetAccounting.review.cases[0].caseId, report.cases[0].id);
  assert.deepEqual(item, before);
  assert.doesNotMatch(JSON.stringify(report), /token_budget_accounting/);
  assert.deepEqual(validateReportShape(report), []);
  assert.deepEqual(recomputeReport(report).cases, report.cases);
  const changed = structuredClone(report);
  changed.budgetAccounting.dut.cases[0].caseId = "token_different_identity";
  assert.throws(() => recomputeReport(changed), /caseId/);
  assert.deepEqual(changed.cases, report.cases);
});

test("truthful unknown accounting need not be aborted, unsettled, priced, erroneous or positively observed", () => {
  for (const patch of [
    {}, { executionSettled: false }, { aborted: true }, { error: "" },
    { observedLowerBound: { ...zeroUsage(), priced: false } },
    { observedLowerBound: { ...usage, priced: true, currencyMicros: 9 } },
    { outstandingReservations: { inputTokens: 5, outputTokens: 2, modelRequests: 1, toolCalls: 0 } },
    { unresolvedExposure: { inputTokens: 5, outputTokens: 2, modelRequests: 1, toolCalls: 0 } },
  ]) {
    const metadata = runMetadata();
    metadata.budgetAccounting.review = accountingSection([accountingCase({ status: "unknown", ...patch })]);
    const report = accountedReport(2, metadata);
    assert.equal(report.passed, false);
    assert.deepEqual(validateReportShape(report), []);
    assert.deepEqual(recomputeReport(report).budgetAccounting, report.budgetAccounting);
    assert.equal(report.budgetAccounting.review.totals, null);
    assert.equal(report.budgetAccounting.review.completeUsage.modelRequests, 0);
  }
});

test("run vetoes cannot enter the live five-percent allowance or change acceptance/business denominators", () => {
  const cases = Array.from({ length: 20 }, (_, i) => caseV2({ id: `case-${i}`, stage: "live", critical: i === 0 }));
  const actual = new Map(cases.map((row, i) => [row.id, observation(i === 19 ? "failed" : i === 18 ? "correctly_blocked" : "completed")]));
  const manifest = { version: 2, suiteId: "live-veto", stage: "live", cases };
  const clean = evaluateRun(manifest, actual);
  assert.equal(clean.passed, true);
  assert.equal(clean.success.overall.total, 20);
  assert.equal(clean.success.overall.passed, 19);
  assert.equal(clean.businessCompletion.total, 20);
  assert.equal(clean.businessCompletion.completed, 18);
  for (const veto of ["cleanup", "accounting"]) {
    const records = cases.map((row) => accountingCase({ caseId: row.id }));
    if (veto === "accounting") records[18].status = "unknown";
    const metadata = runMetadata({
      budgetAccounting: { dut: accountingSection(records), review: accountingSection([]) },
      connectionCleanupErrors: veto === "cleanup" ? ["failed close"] : [],
    });
    const report = evaluateRun(manifest, actual, { runMetadata: metadata });
    assert.equal(report.passed, false);
    assert.deepEqual(report.cases, clean.cases);
    assert.deepEqual(report.success, clean.success);
    assert.deepEqual(report.businessCompletion, clean.businessCompletion);
    assert.equal(report.gates.overall95, "passed");
    assert.deepEqual(validateReportShape(report), []);
    assert.equal(recomputeReport(report).passed, false);
  }
});

test("new clean native metadata round-trips through CLI without changing v1 and generic v2 readback", async (t) => {
  const root = join("artifacts", `acceptance-evaluator-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  for (const report of [legacyReport(), reportV2(), accountedReport(1, runMetadata()), accountedReport(2, runMetadata())]) {
    const bytes = JSON.stringify(report);
    await writeFile(path, bytes);
    const result = await evaluateAcceptance(["--report", path]);
    assert.equal(result.code, 0, result.shapeErrors.join("\n"));
    assert.deepEqual(result.shapeErrors, []);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(recomputeReport(report).passed, true);
  }
});

test("historical v1 runner review usage and cleanup receipts do not require retroactive accounting", async (t) => {
  const root = join("artifacts", `acceptance-evaluator-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  for (const review of [{ ...zeroUsage(), priced: false }, { ...usage }, { ...usage, priced: true, currencyMicros: 17 }]) {
    const old = { ...legacyReport(), independentReviewUsage: review,
      cleanupReceipts: [{ caseId: "v2-case", receipt: { cleaned: true } }] };
    old.cases[0].metrics.execution = { status: "completed" };
    const bytes = JSON.stringify(old);
    assert.deepEqual(validateReportShape(old), []);
    let replay = old;
    for (let count = 0; count < 3; count++) {
      replay = recomputeReport(replay);
      assert.equal(replay.passed, true);
      assert.deepEqual(replay.gates, old.gates);
      assert.deepEqual(replay.independentReviewUsage, review);
      assert.equal(Object.hasOwn(replay, "budgetAccounting"), false);
      assert.equal(Object.hasOwn(replay, "runMetadataVersion"), false);
    }
    await writeFile(path, bytes);
    assert.equal((await evaluateAcceptance(["--report", path])).code, 0);
    assert.equal(await readFile(path, "utf8"), bytes);
    old.connectionCleanupErrors = ["historical failed close"];
    old.gates.connectionCleanup = "failed";
    old.passed = false;
    assert.deepEqual(validateReportShape(old), []);
    assert.equal(recomputeReport(old).passed, false);
    await writeFile(path, JSON.stringify(old));
    const failed = await evaluateAcceptance(["--report", path]);
    assert.equal(failed.code, 1);
    assert.deepEqual(failed.shapeErrors, []);
  }
  for (const invalid of [null, true, {}, { ...usage, inputTokens: -1 }]) {
    const old = { ...legacyReport(), independentReviewUsage: invalid };
    assert.throws(() => recomputeReport(old), /independentReviewUsage/);
  }
});

test("invalid case replay cannot gain a fresh checksum while run vetoes survive repeated rebuilding", () => {
  const metadata = runMetadata({ connectionCleanupErrors: ["failed close"] });
  metadata.budgetAccounting.review = accountingSection([accountingCase({ status: "unknown", error: "late callback" })]);
  let report = accountedReport(2, metadata);
  report.cases[0].evidenceSummary.policyFacts.allowed = false;
  const stale = report.cases[0].replay.sha256;
  for (let count = 0; count < 4; count++) {
    report = recomputeReport(JSON.parse(JSON.stringify(report)));
    assert.equal(report.passed, false);
    assert.equal(report.gates.connectionCleanup, "failed");
    assert.equal(report.gates.budgetAccounting, "failed");
    assert.equal(report.cases[0].replay.kind, "invalid-case-replay");
    assert.equal(report.cases[0].replay.sha256, undefined);
    assert.notEqual(report.cases[0].replay.sha256, stale);
    assert.ok(validateReportShape(report).some((error) => /replay/.test(error)));
  }
});
