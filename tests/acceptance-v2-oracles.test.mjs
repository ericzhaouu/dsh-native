import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { compileCorpus } from "../scripts/compile-acceptance.mjs";
import { compileExpectationContract, compileFixtureScope } from "../scripts/lib/acceptance-expectations.mjs";
import { corpusObservationDigest, evidenceDigest, evaluateCorpusEvidence, loadCorpusOracles } from "../scripts/lib/acceptance-oracles.mjs";
import { buildReport, evaluateCase, recomputeReport, recomputeReportGates, validateReportShape } from "../scripts/lib/acceptance-evaluator.mjs";
import { redact } from "../scripts/lib/acceptance-contract.mjs";

const usage = { modelRequests: 1, inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, toolCalls: 0, userTurns: 1, priced: false };
function fixture(expectations = [{ modes: ["draft", "clarify"], permittedOutcomes: ["completed", "correctly_blocked"] }]) {
  const reviews = expectations.map((expected, index) => ({
    submissionId: `case-a-t${index + 1}`, expected,
    oracle: { businessAssertions: ["correct answer"], safetyAssertions: ["authorized only"], forbiddenEffects: ["no writes"] },
  }));
  const contract = compileExpectationContract(reviews, reviews.map((review) => review.submissionId));
  const prompts = reviews.map((_, index) => `turn-${index}`);
  const testCase = {
    id: "case-a", agentProfile: "agent-a", stage: "offline", critical: true, prompt: prompts[0],
    ...(prompts.length > 1 ? { turns: prompts } : {}),
    expected: { ...contract, authorityAndSafety: "passed", delivery: { delivered: true, terminalOutputs: prompts.length } },
  };
  const oracleCase = {
    agentProfile: { agentId: "agent-a", skillAllowlist: [] }, fixtureRefs: [], reviews,
    expectationContract: contract, fixtureScope: compileFixtureScope({}),
  };
  const evidence = {
    executionStatus: "completed", businessResult: "partial", sideEffects: [], usage,
    delivery: { delivered: true, terminalOutputs: prompts.length },
    turns: reviews.map((review, index) => ({
      prompt: prompts[index], outputText: "observed answer", mode: review.expected.modes[0],
      executionStatus: "completed", tools: [], skill: { advertised: [], selected: [], loaded: [] },
      agentProfile: "agent-a", usage, delivery: { delivered: true, terminalOutputs: 1 },
    })),
  };
  return { testCase, oracleCase, evidence };
}
function reviewFor(input, outcomes = input.oracleCase.reviews.map(() => "completed")) {
  return {
    caseId: input.testCase.id, evidenceSha256: evidenceDigest(input.evidence), usage,
    turns: input.oracleCase.reviews.map((review, index) => ({
      submissionId: review.submissionId,
      verdict: { executionStatus: outcomes[index], businessResult: outcomes[index] === "completed" ? "passed" : outcomes[index] === "correctly_blocked" ? "not_applicable" : "failed" },
      ...Object.fromEntries(["business", "safety", "forbiddenEffects"].map((key) => [key, [{ assertionIndex: 0, passed: true, rationale: "independent observation" }]])),
    })),
  };
}
function grade(input, review = reviewFor(input)) {
  return evaluateCorpusEvidence({ ...input, semanticReview: review });
}

const sensitiveTargets = [
  ["alice@example.test", "victim@example.test"],
  ["token_authorized123456", "token_unauthorized123456"],
];
function authorizedWrite(target) {
  const input = fixture([{ modes: ["execute"], permittedOutcomes: ["completed"] }]);
  input.oracleCase.fixtureScope.requiredCapabilities = ["authorized-test-write"];
  input.evidence.scopeReceipts = [{
    capability: "authorized-test-write", authorized: true, selfAsserted: false,
    receiptId: "write-scope", caseId: input.testCase.id, allowedEffects: [{ kind: "write", id: target }],
  }];
  input.evidence.sideEffects = [{ kind: "write", id: target, authorizationReceiptId: "write-scope" }];
  input.evidence.turns[0].tools = [{
    name: "write", effect: { kind: "write", id: target }, authorizationReceiptId: "write-scope",
    arguments: { password: "private-fixture-password" },
  }];
  return input;
}
function reportFor(input, result = evaluateCase(input.testCase, input.evidence)) {
  return buildReport({ version: 2, suiteId: "integrity-regression", stage: "offline" }, [result]);
}

test("sensitive target swaps before grading remain unauthorized even with a fresh semantic review", () => {
  for (const [authorized, unauthorized] of sensitiveTargets) {
    for (const observed of ["effect", "callback"]) {
      const input = authorizedWrite(authorized);
      const before = corpusObservationDigest(input.evidence);
      const review = reviewFor(input);
      if (observed === "effect") input.evidence.sideEffects[0].id = unauthorized;
      else input.evidence.turns[0].tools[0].effect.id = unauthorized;
      assert.notEqual(corpusObservationDigest(input.evidence), before);
      assert.notEqual(grade(input, review).status, "passed");
      const fresh = grade(input);
      assert.equal(fresh.status, "failed");
      assert.equal(fresh.policyFacts.safetyAssertionsPassed, false);
    }
  }
});

test("stale authorized grading cannot survive sensitive target swaps before evaluateCase", () => {
  for (const [authorized, unauthorized] of sensitiveTargets) {
    for (const observed of ["effect", "callback", "scope", "secret"]) {
      const input = authorizedWrite(authorized);
      input.evidence.corpusGrading = grade(input);
      assert.equal(input.evidence.corpusGrading.status, "passed");
      const redactedBefore = redact(input.evidence);
      if (observed === "effect") input.evidence.sideEffects[0].id = unauthorized;
      else if (observed === "callback") input.evidence.turns[0].tools[0].effect.id = unauthorized;
      else if (observed === "scope") input.evidence.scopeReceipts[0].allowedEffects[0].id = unauthorized;
      else input.evidence.turns[0].tools[0].arguments.password = "other-private-fixture-password";
      assert.deepEqual(redact(input.evidence), redactedBefore, "reproduces the lossy-redaction collision");
      const result = evaluateCase(input.testCase, input.evidence);
      assert.equal(result.outcome, "failed");
      assert.match(result.errors.join("\n"), /observationSha256/);
      const report = reportFor(input, result);
      assert.equal(report.passed, false);
      const saved = JSON.parse(JSON.stringify(redact(report)));
      assert.deepEqual(validateReportShape(saved), []);
      assert.equal(recomputeReportGates(saved).critical100, "failed", "serialization cannot heal stale raw evidence");
    }
  }
});

test("buildReport accepts only unchanged evaluator snapshots, not redaction-colliding edits", () => {
  for (const [authorized, unauthorized] of sensitiveTargets) {
    const input = authorizedWrite(authorized);
    input.evidence.corpusGrading = grade(input);
    const result = evaluateCase(input.testCase, input.evidence);
    assert.equal(result.outcome, "passed");
    result.evidenceSummary.sideEffects[0].id = unauthorized;
    assert.throws(() => reportFor(input, result), /snapshot|changed|evaluated/i);
    const good = evaluateCase(input.testCase, input.evidence);
    assert.throws(() => reportFor(input, structuredClone(good)), /snapshot|evaluated/i);
  }
});

test("persisted replay checks exact stored bytes before redaction and rejects target substitution", () => {
  for (const [authorized, unauthorized] of sensitiveTargets) {
    const input = authorizedWrite(authorized);
    input.evidence.corpusGrading = grade(input);
    const report = reportFor(input);
    assert.equal(report.passed, true);
    for (const target of [authorized, unauthorized]) {
      const edited = structuredClone(report);
      edited.cases[0].evidenceSummary.sideEffects[0].id = target;
      assert.ok(validateReportShape(edited).length);
      assert.equal(recomputeReportGates(edited).critical100, "failed");
      let replayed = recomputeReport(edited);
      for (let attempt = 0; attempt < 3; attempt++) {
        replayed = recomputeReport(JSON.parse(JSON.stringify(redact(replayed))));
        assert.equal(replayed.passed, false, "repeated replay must not issue a fresh trusted binding");
        assert.ok(validateReportShape(replayed).length);
      }
    }
  }
});

test("validated snapshots isolate source evidence, grading, contract and case mutations", () => {
  const input = authorizedWrite(sensitiveTargets[0][0]);
  input.evidence.corpusGrading = grade(input);
  const result = evaluateCase(input.testCase, input.evidence);
  input.evidence.sideEffects[0].id = sensitiveTargets[0][1];
  input.evidence.corpusGrading.policyFacts.safetyAssertionsPassed = false;
  input.evidence.delivery.delivered = false;
  input.testCase.expected.allowedModes.length = 0;
  const report = reportFor(input, result);
  assert.equal(report.passed, true, "the report describes the immutable evaluated snapshot");
  result.evidenceSummary.scopeReceipts[0].allowedEffects[0].id = "later-change";
  result.metrics.delivery.delivered = false;
  assert.deepEqual(validateReportShape(report), []);
  assert.equal(report.cases[0].evidenceSummary.sideEffects[0].id, "[redacted-email]");
});

test("raw grading and redacted replay use explicit distinct protocols and round-trip without secrets", () => {
  for (const [authorized] of sensitiveTargets) {
    const input = authorizedWrite(authorized);
    input.evidence.corpusGrading = grade(input);
    assert.equal(input.evidence.corpusGrading.observationDigestKind, "raw-corpus-observation-v1");
    const report = reportFor(input);
    const binding = report.cases[0].replay;
    assert.equal(binding.kind, "redacted-case-replay-v1");
    assert.equal(binding.rawObservationSha256, input.evidence.corpusGrading.observationSha256);
    assert.notEqual(binding.sha256, binding.rawObservationSha256);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(authorized), false);
    assert.equal(serialized.includes("private-fixture-password"), false);
    const saved = JSON.parse(JSON.stringify(redact(report)));
    assert.deepEqual(validateReportShape(saved), []);
    assert.equal(recomputeReportGates(saved).critical100, "passed");
    assert.equal(evaluateCase(input.testCase, saved.cases[0].evidenceSummary).outcome, "failed",
      "a public replay summary is not raw producer evidence");
    for (const value of [undefined, "", "redacted-case-replay-v1"]) {
      const invalid = structuredClone(input.evidence);
      invalid.corpusGrading.observationDigestKind = value;
      assert.equal(evaluateCase(input.testCase, invalid).outcome, "failed");
    }
    for (const value of [undefined, "", "0".repeat(64)]) {
      const invalid = structuredClone(input.evidence);
      invalid.corpusGrading.observationSha256 = value;
      assert.equal(evaluateCase(input.testCase, invalid).outcome, "failed");
    }
    for (const field of ["kind", "rawObservationSha256", "sha256"]) {
      for (const value of [undefined, "", "unknown", "0".repeat(64)]) {
        const invalid = structuredClone(saved);
        invalid.cases[0].replay[field] = value;
        assert.ok(validateReportShape(invalid).length);
        const rejected = recomputeReport(invalid);
        assert.equal(rejected.passed, false);
        assert.equal(recomputeReport(rejected).passed, false);
      }
    }
  }
});

test("redacted replay preserves raw assertion failures and successes instead of comparing collapsed targets", () => {
  for (const [authorized, other] of sensitiveTargets) {
    for (const assertion of ["allowed", "denied"]) {
      const input = authorizedWrite(authorized);
      input.testCase.assertions = { sideEffects: { [assertion]: [{ kind: "write", id: other }] } };
      input.evidence.corpusGrading = grade(input);
      assert.equal(input.evidence.corpusGrading.status, "passed");
      const shouldPass = assertion === "denied";
      let report = reportFor(input);
      assert.equal(report.passed, shouldPass);
      for (let attempt = 0; attempt < 3; attempt++) {
        const saved = JSON.parse(JSON.stringify(redact(report)));
        assert.deepEqual(validateReportShape(saved), []);
        report = recomputeReport(saved);
        assert.equal(report.passed, shouldPass, "lossy redaction must neither heal failure nor invent failure");
        assert.deepEqual(validateReportShape(report), []);
      }
    }
  }
});

test("raw observation commitment covers case-level agent fallback and unknown-effect flags", () => {
  const input = fixture();
  delete input.evidence.turns[0].agentProfile;
  input.evidence.agentProfile = "agent-a";
  input.evidence.corpusGrading = grade(input);
  assert.equal(input.evidence.corpusGrading.status, "passed");
  assert.equal(reportFor(input).passed, true);
  for (const patch of [{ agentProfile: "wrong-agent" }, { liveUnknown: true }, { unknownEffects: true }]) {
    const changed = { ...input, evidence: { ...input.evidence, ...patch } };
    assert.notEqual(corpusObservationDigest(changed.evidence), input.evidence.corpusGrading.observationSha256);
    assert.notEqual(grade(changed).status, "passed");
    const result = evaluateCase(changed.testCase, changed.evidence);
    assert.equal(result.outcome, "failed");
    const report = reportFor(changed, result);
    assert.equal(report.passed, false);
    assert.deepEqual(validateReportShape(report), []);
  }
});

test("deleting or changing raw case status cannot reuse legitimate grading at any report boundary", () => {
  for (const status of [undefined, "unknown", "failed", "infrastructure_blocked", "correctly_blocked"]) {
    const input = authorizedWrite(sensitiveTargets[0][0]);
    input.evidence.corpusGrading = grade(input);
    const good = evaluateCase(input.testCase, input.evidence);
    const report = reportFor(input, good);
    const change = (evidence) => {
      if (status === undefined) delete evidence.executionStatus;
      else evidence.executionStatus = status;
    };
    change(input.evidence);
    assert.notEqual(corpusObservationDigest(input.evidence), input.evidence.corpusGrading.observationSha256);
    const failed = evaluateCase(input.testCase, input.evidence);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.infrastructure_blocked, status === "infrastructure_blocked");
    if (status === undefined || status === "unknown") assert.match(failed.errors.join("\n"), /invalid or missing executionStatus/);
    const rejected = reportFor(input, failed);
    assert.equal(rejected.passed, false);
    assert.deepEqual(validateReportShape(JSON.parse(JSON.stringify(rejected))), []);
    change(good.evidenceSummary);
    assert.throws(() => reportFor(input, good), /snapshot|changed|evaluated/i);
    change(report.cases[0].evidenceSummary);
    assert.ok(validateReportShape(report).length);
    assert.equal(recomputeReportGates(report).critical100, "failed");
  }
});

test("even matching raw commitments cannot hide missing status or promote raw failure and infrastructure", () => {
  for (const status of [undefined, "unknown", "failed", "infrastructure_blocked"]) {
    const input = authorizedWrite(sensitiveTargets[0][0]);
    input.evidence.corpusGrading = grade(input);
    if (status === undefined) delete input.evidence.executionStatus;
    else input.evidence.executionStatus = status;
    input.evidence.corpusGrading.observationSha256 = corpusObservationDigest(input.evidence);
    const result = evaluateCase(input.testCase, input.evidence);
    assert.equal(result.outcome, status === "infrastructure_blocked" ? "blocked" : "failed");
    const report = reportFor(input, result);
    assert.equal(report.passed, false);
    assert.deepEqual(validateReportShape(report), []);
  }
});

test("independent draft refusal and completion both satisfy dual outcomes without mode-derived grading", () => {
  const input = fixture();
  for (const outcome of ["completed", "correctly_blocked"]) {
    const result = grade(input, reviewFor(input, [outcome]));
    assert.equal(result.status, "passed", result.errors.join("\n"));
    assert.equal(result.executionStatus, outcome);
    assert.equal(result.businessResult, outcome === "completed" ? "passed" : "not_applicable");
    const evaluated = evaluateCase(input.testCase, { ...input.evidence, corpusGrading: result });
    assert.equal(evaluated.outcome, "passed", evaluated.errors.join("\n"));
    assert.equal(evaluated.business_completed, outcome === "completed");
  }
});

test("required completion rejects a refusal and infrastructure can never satisfy either allowed outcome", () => {
  const input = fixture([{ modes: ["draft"], permittedOutcomes: ["completed"] }]);
  assert.equal(grade(input, reviewFor(input, ["correctly_blocked"])).status, "failed");
  for (const status of ["infrastructure_blocked", "failed"]) {
    const blocked = fixture();
    blocked.evidence.turns[0].executionStatus = status;
    assert.notEqual(grade(blocked, reviewFor(blocked, ["correctly_blocked"])).status, "passed");
  }
});

test("missing/unknown verdict and observed outcomes fail instead of defaulting to completion", () => {
  for (const value of [undefined, "unknown"]) {
    const input = fixture();
    const review = reviewFor(input);
    review.turns[0].verdict.executionStatus = value;
    assert.equal(grade(input, review).status, "failed");
    input.evidence.turns[0].executionStatus = value;
    assert.equal(grade(input).status, "failed");
    const missingCase = fixture();
    missingCase.evidence.executionStatus = value;
    assert.equal(grade(missingCase).status, "failed");
  }
  const input = fixture();
  const review = reviewFor(input);
  delete review.turns[0].verdict;
  assert.equal(grade(input, review).status, "failed");
  const inconsistent = reviewFor(input, ["correctly_blocked"]);
  inconsistent.turns[0].verdict.businessResult = "passed";
  assert.equal(grade(input, inconsistent).status, "failed");
});

test("allowed outcomes never waive modes, authorization, or forbidden effects", () => {
  const input = fixture();
  input.evidence.turns[0].mode = "chat";
  assert.equal(grade(input).status, "failed");
  input.evidence.turns[0].mode = "draft";
  input.evidence.sideEffects = [{ kind: "write", id: "anything" }];
  const result = grade(input, reviewFor(input, ["correctly_blocked"]));
  assert.equal(result.status, "failed");
  assert.equal(result.policyFacts.safetyAssertionsPassed, false);
  input.evidence.sideEffects = [];
  const review = reviewFor(input);
  review.turns[0].forbiddenEffects[0].passed = false;
  assert.equal(grade(input, review).status, "failed");
  input.evidence.turns[0].tools = [{ name: "write", arguments: {} }];
  assert.equal(grade(input).status, "failed");
  const execute = fixture([{ modes: ["execute"], permittedOutcomes: ["completed"] }]);
  execute.evidence.turns[0].tools = [{ name: "write", arguments: { path: "not-authorized" } }];
  assert.equal(grade(execute).status, "failed");
});

test("multi-turn verdicts align by submission and input rather than reusing the final outcome", () => {
  const input = fixture([
    { modes: ["clarify"], permittedOutcomes: ["correctly_blocked"] },
    { modes: ["draft"], permittedOutcomes: ["completed"] },
  ]);
  const review = reviewFor(input, ["correctly_blocked", "completed"]);
  const result = grade(input, review);
  assert.equal(result.status, "passed", result.errors.join("\n"));
  assert.equal(result.executionStatus, "completed");
  assert.equal(evaluateCase(input.testCase, { ...input.evidence, corpusGrading: result }).outcome, "passed");
  const swapped = structuredClone(review);
  swapped.turns.reverse();
  assert.notEqual(grade(input, swapped).status, "passed");
  assert.equal(grade(input, reviewFor(input, ["completed", "completed"])).status, "failed");
  input.evidence.turns.reverse();
  assert.equal(grade(input, reviewFor(input, ["correctly_blocked", "completed"])).status, "failed");
});

test("semantic review remains digest-bound and zero-tool, independent of spoofed adapter facts", () => {
  const input = fixture();
  const review = reviewFor(input);
  review.usage = { ...usage, toolCalls: 1 };
  assert.equal(grade(input, review).status, "blocked");
  const stale = reviewFor(input);
  input.evidence.turns[0].outputText = "changed";
  assert.equal(grade(input, stale).status, "blocked");
  input.evidence.policyFacts = { independentOracleEvaluated: true };
  assert.notEqual(evaluateCorpusEvidence(input).status, "passed");
});

test("read-only/static scope cannot fulfill a positive write case or create write authority", () => {
  const input = fixture();
  input.oracleCase.fixtureScope.requiredCapabilities = ["authorized-test-write"];
  assert.equal(grade(input).status, "blocked");
  input.evidence.scopeReceipts = [{ capability: "authorized-test-write", authorized: true, selfAsserted: true, receiptId: "r", caseId: "case-a" }];
  assert.equal(grade(input).status, "blocked");
  input.evidence.scopeReceipts[0].selfAsserted = false;
  assert.equal(grade(input).status, "blocked");
  input.evidence.scopeReceipts[0].allowedEffects = [{ kind: "write", id: "approved-target" }];
  assert.equal(grade(input).status, "passed");
  input.evidence.sideEffects = [{ kind: "write", authorizationReceiptId: "foreign" }];
  assert.equal(grade(input).status, "failed");
  input.evidence.sideEffects = [{ kind: "write", id: "wrong-target", authorizationReceiptId: "r" }];
  assert.equal(grade(input).status, "failed");
});

test("v2 sidecar validates hash, version and full contract binding including intermediate turns", async (t) => {
  const root = resolve("artifacts", `v073-oracle-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { manifest, oracles } = await compileCorpus({ subset: "multi" });
  const path = resolve(root, "oracles.json");
  const write = async () => {
    const bytes = `${JSON.stringify(oracles, null, 2)}\n`;
    await writeFile(path, bytes);
    manifest.corpusOracle.sha256 = createHash("sha256").update(bytes).digest("hex");
  };
  await write();
  assert.equal((await loadCorpusOracles(path, manifest)).version, 2);
  const invalid = structuredClone(manifest);
  invalid.version = 1;
  await assert.rejects(loadCorpusOracles(path, invalid), /version/);
  invalid.version = 2;
  invalid.cases[0].expected.turnExpectations[0].allowedOutcomes = ["completed"];
  await assert.rejects(loadCorpusOracles(path, invalid), /expectationContract/);
  oracles.cases[manifest.cases[0].id].reviews[0].expected.permittedOutcomes = ["infrastructure_blocked"];
  await write();
  await assert.rejects(loadCorpusOracles(path, manifest), /permittedOutcomes/);
});
