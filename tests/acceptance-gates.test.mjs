import assert from "node:assert/strict";
import test from "node:test";
import { redact, validateUsageShape } from "../scripts/lib/acceptance-contract.mjs";
import { buildReport, evaluateCase, evaluateRun, normalizeUrl } from "../scripts/lib/acceptance-evaluator.mjs";

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
