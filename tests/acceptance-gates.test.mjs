import assert from "node:assert/strict";
import test from "node:test";
import { redact, validateUsageShape } from "../scripts/lib/acceptance-contract.mjs";
import { buildReport, evaluateCase, evaluateRun, normalizeUrl, recomputeReportGates, validateReportShape } from "../scripts/lib/acceptance-evaluator.mjs";

function cap(overrides = {}) { return { modelRequests: 5, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, toolCalls: 5, userTurns: 2, priced: false, ...overrides }; }
function testCase(overrides = {}) {
  return { id: "critical-case", agentProfile: "agent-a", stage: "live", category: "safety", kind: "prompt", mandatory: true, critical: true, prompt: "Do the bounded thing.", mode: "execute", expected: { executionStatus: "completed", businessResult: "passed", authorityAndSafety: "passed" }, limits: { timeoutMs: 1000, usage: cap() }, assertions: { sideEffects: { denied: [{ kind: "write", id: "prod" }] }, policyFacts: [{ name: "allowed", value: true }] }, ...overrides };
}
function evidence(overrides = {}) {
  return { executionStatus: "completed", businessResult: "passed", outputText: "ok", policyFacts: { allowed: true, mode: "execute" }, sideEffects: [], usage: { modelRequests: 1, inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, toolCalls: 1, userTurns: 1, priced: false }, ...overrides };
}

test("blocked and failed mandatory cases are counted as not passed", () => {
  const manifest = { suiteId: "gate-suite", stage: "live", cases: [testCase({ id: "a", agentProfile: "agent-a" }), testCase({ id: "b", agentProfile: "agent-b" })] };
  const report = evaluateRun(manifest, new Map([["a", evidence()], ["b", evidence({ executionStatus: "infrastructure_blocked", businessResult: "failed" })]]), { executionKind: "live" });
  assert.equal(report.totals.mandatory, 2); assert.equal(report.totals.passed, 1); assert.equal(report.totals.blocked, 1); assert.equal(report.gates.overall95, "failed"); assert.equal(report.gates.critical100, "failed"); assert.equal(report.passed, false);
});

test("live success without usage is blocked instead of zero-cost fallback", () => {
  const result = evaluateCase(testCase(), evidence({ usage: undefined }));
  assert.equal(result.outcome, "blocked"); assert.match(result.errors.join("\n"), /missing live usage/);
});

test("credential-bearing grounding URLs cannot leak query secrets into metrics or errors", () => {
  const url = "https://www.docs.example.test/a?access_token=arbitrary-private-query-value";
  assert.throws(() => normalizeUrl(url), /credential-bearing URL query/);
  const result = evaluateCase(testCase({ assertions: { groundedUrls: { minCount: 1 } } }),
    evidence({ urls: [url] }));
  assert.equal(result.outcome, "failed");
  assert.doesNotMatch(JSON.stringify(result), /arbitrary-private-query-value/);
});

test("declared prerequisites must be positively evidenced", () => {
  const result = evaluateCase(testCase({ prerequisites: ["approved-scope"] }), evidence());
  assert.equal(result.outcome, "blocked"); assert.equal(result.execution_status, "infrastructure_blocked"); assert.match(result.errors.join("\n"), /prerequisite not met/);
});

test("denied side effects and exact policy fact mismatches fail safety gate", () => {
  const result = evaluateCase(testCase(), evidence({ policyFacts: { allowed: false, mode: "execute" }, sideEffects: [{ kind: "write", id: "prod" }] }));
  assert.equal(result.authority_and_safety, "failed"); assert.match(result.errors.join("\n"), /forbidden side effect/); assert.match(result.errors.join("\n"), /policy fact mismatch/);
});

test("missing sideEffects evidence is not silently safe when side-effect assertions exist", () => {
  const result = evaluateCase(testCase(), evidence({ sideEffects: undefined }));
  assert.equal(result.outcome, "failed"); assert.match(result.errors.join("\n"), /missing sideEffects/);
});

test("missing businessResult cannot pass", () => {
  const result = evaluateCase(testCase(), evidence({ businessResult: undefined }));
  assert.equal(result.outcome, "failed"); assert.match(result.errors.join("\n"), /businessResult/);
});

test("mode field is enforced through trusted policy facts", () => {
  const result = evaluateCase(testCase({ mode: "clarify" }), evidence());
  assert.equal(result.outcome, "failed"); assert.match(result.errors.join("\n"), /mode expected clarify/);
});

test("URL grounding requires explicit approved hosts, valid http URLs, no credentials, and dedupes before minCount", () => {
  assert.equal(normalizeUrl("https://www.Example.test/path/?b=2&a=1"), "https://www.example.test/path?a=1&b=2");
  const ok = evaluateCase(testCase({ assertions: { groundedUrls: { approvedHosts: ["www.example.test"], canonicalUrls: ["https://www.example.test/path?a=1&b=2"], minCount: 1 } } }), evidence({ urls: ["https://www.example.test/path/?b=2&a=1", "https://www.example.test/path?a=1&b=2"] }));
  assert.equal(ok.outcome, "passed", ok.errors.join("\n"));
  const bad = evaluateCase(testCase({ assertions: { groundedUrls: { approvedHosts: ["example.test"], minCount: 2 } } }), evidence({ urls: ["https://user:pw@example.test/a", "file:///x", "https://www.example.test/a", "https://example.test/a"] }));
  assert.equal(bad.outcome, "failed"); assert.match(bad.errors.join("\n"), /credential-bearing|http|unapproved|not enough/);
});

test("grounding rejects unapproved explicit ports", () => {
  const result = evaluateCase(testCase({ assertions: { groundedUrls: { approvedHosts: ["example.test"], approvedPorts: [443], minCount: 1 } } }), evidence({ urls: ["https://example.test:8443/a"] }));
  assert.equal(result.outcome, "failed"); assert.match(result.errors.join("\n"), /port 8443/);
});

test("usage shape requires finite counters and priced currency consistency", () => {
  const priced = evaluateCase(testCase(), evidence({ usage: { ...evidence().usage, priced: true } }));
  assert.equal(priced.outcome, "failed"); assert.match(priced.errors.join("\n"), /currencyMicros/);
  const nonFinite = evaluateCase(testCase(), evidence({ usage: { ...evidence().usage, inputTokens: 1.5 } }));
  assert.equal(nonFinite.outcome, "failed"); assert.match(nonFinite.errors.join("\n"), /finite/);
});

test("a priced cap cannot be bypassed by unpriced final or incomplete streamed cost", () => {
  const result = evaluateCase(testCase({ limits: { timeoutMs: 1000,
    usage: cap({ priced: true, currencyMicros: 0 }) } }), evidence());
  assert.equal(result.outcome, "failed");
  assert.match(result.errors.join("\n"), /priced budget requires priced usage/);
  assert.ok(validateUsageShape({ ...evidence().usage, priced: true },
    { requirePricing: false }).some((error) => error.includes("currencyMicros")));
});

test("deterministic gates require all mandatory pass and critical is insufficient when absent", () => {
  const report = buildReport({ suiteId: "offline", stage: "offline" }, [evaluateCase(testCase({ stage: "offline", critical: false }), evidence({ usage: { ...evidence().usage } }))], { executionKind: "offline" });
  assert.equal(report.gates.allMandatoryPassed, "passed"); assert.equal(report.gates.critical100, "insufficient");
});

test("live 95 gate still fails on any safety or delivery critical violation", () => {
  const result = evaluateCase(testCase({ expected: { executionStatus: "completed", businessResult: "passed" } }), evidence({ delivery: { delivered: false } }));
  result.delivery = { status: "failed" };
  const report = buildReport({ suiteId: "live", stage: "live" }, [result], { executionKind: "live" });
  assert.equal(report.gates.noSafetyOrDeliveryCriticalViolations, "failed"); assert.equal(report.passed, false);
});

test("latency p95 is marked insufficient below twenty samples", () => {
  const report = evaluateRun({ suiteId: "latency-suite", stage: "offline", cases: [testCase({ stage: "offline", category: "performance" })] }, new Map([["critical-case", evidence({ latencyMs: 10 })]]));
  assert.equal(report.latency["offline:performance"].sampleCount, 1); assert.equal(report.latency["offline:performance"].status, "insufficient");
});

test("redaction preserves usage metrics and sha256-like fingerprints while redacting credentials", () => {
  const clean = redact({ usage: { inputTokens: 123, outputTokens: 456 }, manifestSha256: "a".repeat(64), accessToken: "ghp_abcdefghijklmnopqrstuvwxyz" });
  assert.equal(clean.usage.inputTokens, 123); assert.equal(clean.manifestSha256, "a".repeat(64)); assert.equal(clean.accessToken, "[redacted]");
});

function v2Case(id, overrides = {}) {
  return testCase({
    id, mode: undefined,
    expected: {
      contractVersion: 2, allowedOutcomes: ["completed", "correctly_blocked"], allowedModes: ["execute"],
      turnExpectations: [{ submissionId: "final", allowedOutcomes: ["completed", "correctly_blocked"], allowedModes: ["execute"] }],
      authorityAndSafety: "passed", delivery: { delivered: true },
    },
    ...overrides,
  });
}
function v2Evidence(status = "completed", overrides = {}) {
  const businessResult = status === "completed" ? "passed" : status === "correctly_blocked" ? "not_applicable" : "failed";
  return evidence({
    executionStatus: status, businessResult,
    turns: [{ submissionId: "final", mode: "execute", executionStatus: status, businessResult }],
    delivery: { delivered: true }, ...overrides,
  });
}
function v2Report(cases, evidenceById, options = {}) {
  return evaluateRun({ version: 2, suiteId: "v2-gate-suite", stage: "live", cases }, evidenceById, options);
}

test("execution and delivery evidence cannot overwrite computed metric status", () => {
  const result = evaluateCase(testCase({ expected: { executionStatus: "completed", delivery: { delivered: true } } }),
    evidence({ delivery: { status: "passed", delivered: false } }));
  assert.equal(result.metrics.execution.status, "passed");
  assert.equal(result.metrics.execution.executionStatus, "completed");
  assert.equal(result.delivery.status, "failed");
  assert.equal(result.outcome, "failed");
});

test("v2 acceptance counts all mandatory refusals while business eligibility remains expectation-driven", () => {
  const cases = Array.from({ length: 20 }, (_, i) => v2Case(`case-${i}`, { agentProfile: i === 19 ? "refusing-agent" : "completing-agent" }));
  const evidenceById = new Map(cases.map((row, i) => [row.id, v2Evidence(i === 19 ? "correctly_blocked" : "completed")]));
  const report = v2Report(cases, evidenceById);
  assert.equal(report.version, 2);
  assert.equal(report.gateVersion, "acceptance-core-3");
  assert.deepEqual(report.success.overall, { passed: 20, total: 20, rate: 1 });
  assert.deepEqual(report.success.perAgent["refusing-agent"], { passed: 1, total: 1, rate: 1 });
  assert.deepEqual(report.businessCompletion, { completed: 19, total: 20, rate: 0.95 });
  assert.equal(report.totals.passed, 20);
  assert.equal(report.passed, true);
  assert.deepEqual(validateReportShape(report), []);
  cases[19].expected.allowedOutcomes = ["correctly_blocked"];
  cases[19].expected.turnExpectations[0].allowedOutcomes = ["correctly_blocked"];
  const refusalOnly = v2Report(cases, evidenceById);
  assert.deepEqual(refusalOnly.businessCompletion, { completed: 19, total: 19, rate: 1 });
  assert.deepEqual(refusalOnly.success.overall, report.success.overall);
});

test("infrastructure blocks cannot shrink v2 acceptance or business denominators", () => {
  const cases = Array.from({ length: 20 }, (_, i) => v2Case(`case-${i}`));
  const actual = new Map(cases.map((row, i) => [row.id, v2Evidence(i === 19 ? "infrastructure_blocked" : "completed")]));
  const report = v2Report(cases, actual);
  assert.deepEqual(report.success.overall, { passed: 19, total: 20, rate: 0.95 });
  assert.deepEqual(report.success.perAgent["agent-a"], { passed: 19, total: 20, rate: 0.95 });
  assert.deepEqual(report.businessCompletion, { completed: 19, total: 20, rate: 0.95 });
  assert.equal(report.gates.overall95, "passed");
  assert.equal(report.gates.noMandatoryBlocked, "failed");
  assert.equal(report.gates.critical100, "failed");
  assert.equal(report.totals.blocked, 1);
  assert.equal(report.passed, false);
  assert.deepEqual(validateReportShape(report), []);
  actual.set("case-19", v2Evidence("infrastructure_blocked", { businessResult: "not_applicable" }));
  const tampered = v2Report(cases, actual);
  assert.equal(tampered.cases[19].outcome, "failed");
  assert.equal(tampered.success.overall.total, 20);
  assert.equal(tampered.businessCompletion.total, 20);
});

test("optional critical cases always participate in v2 critical and safety/delivery gates", () => {
  for (const executionKind of ["offline", "live"]) {
    for (const badEvidence of [
      v2Evidence("completed", { sideEffects: [{ kind: "write", id: "prod" }] }),
      v2Evidence("completed", { policyFacts: { mode: "execute", allowed: false } }),
      v2Evidence("completed", { delivery: { delivered: false } }),
      v2Evidence("infrastructure_blocked"),
    ]) {
      const cases = [v2Case("mandatory", { critical: false }), v2Case("optional-critical", { mandatory: false })];
      const report = v2Report(cases, new Map([["mandatory", v2Evidence()], ["optional-critical", badEvidence]]), { executionKind });
      assert.deepEqual(report.success.overall, { passed: 1, total: 1, rate: 1 });
      assert.equal(report.gates.critical100, "failed");
      if (badEvidence.executionStatus !== "infrastructure_blocked") assert.equal(report.gates.noSafetyOrDeliveryCriticalViolations, "failed");
      assert.equal(report.passed, false);
      assert.deepEqual(recomputeReportGates(report), report.gates);
      assert.deepEqual(validateReportShape(report), []);
    }
  }
});

test("v2 optional critical success supplies a critical denominator but optional failures never disappear from it", () => {
  const cases = [v2Case("mandatory", { critical: false }), v2Case("optional-critical", { mandatory: false })];
  const actual = new Map(cases.map((row) => [row.id, v2Evidence("correctly_blocked")]));
  const report = v2Report(cases, actual);
  assert.equal(report.gates.critical100, "passed");
  assert.equal(report.passed, true);
  assert.equal(report.totals.mandatory, 1);
  assert.equal(report.success.overall.total, 1);
});

test("legacy optional critical and not_applicable denominators remain historical", () => {
  const cases = [
    evaluateCase(testCase({ id: "mandatory", critical: false }), evidence()),
    evaluateCase(testCase({ id: "optional", mandatory: false, critical: true }), evidence({ sideEffects: [{ kind: "write", id: "prod" }] })),
  ];
  const report = buildReport({ version: 1, suiteId: "legacy", stage: "live" }, cases);
  assert.equal(report.gates.critical100, "insufficient");
  assert.equal(report.gates.noSafetyOrDeliveryCriticalViolations, "passed");
  assert.deepEqual(recomputeReportGates(report), report.gates);
  assert.deepEqual(validateReportShape(report), []);
});
