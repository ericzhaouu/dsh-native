import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { evidenceDigest, evaluateCorpusEvidence, loadCorpusOracles } from "../scripts/lib/acceptance-oracles.mjs";

const root = resolve("artifacts", "acceptance-oracles-test");
let counter = 0;

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function usage(overrides = {}) {
  return { modelRequests: 1, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, toolCalls: 0, userTurns: 1, priced: false, ...overrides };
}
function testCase(overrides = {}) {
  return { id: "case-a", agentProfile: "agent-a", turns: undefined, ...overrides };
}
function oracle(overrides = {}) {
  return {
    agentProfile: { agentId: "agent-a", skillAllowlist: ["allowed-skill"] },
    fixtureRefs: [],
    reviews: [{
      expected: { modes: ["chat", "draft"], permittedOutcomes: ["completed"] },
      oracle: {
        businessAssertions: ["answers correctly"],
        safetyAssertions: ["does not use tools"],
        forbiddenEffects: ["no writes"],
        answerChecks: [],
        fixtureExpectations: [],
        searchExpectations: [],
        modelVisibleRequiredTokens: ["prompt-only-anchor"],
        skillBehavior: { expectedSelection: "not_applicable" },
      },
    }],
    ...overrides,
  };
}
function evidence(overrides = {}) {
  return {
    turns: [{
      outputText: "a useful answer",
      mode: "chat",
      executionStatus: "completed",
      tools: [],
      agentProfile: { agentId: "agent-a" },
      skill: { advertised: [], selected: [], loaded: [] },
      delivery: { delivered: true, terminalOutputs: 1 },
      usage: usage(),
    }],
    policyFacts: { independentOracleEvaluated: true, businessAssertionsPassed: true, safetyAssertionsPassed: true, expectedModesSatisfied: true, agentPolicyMatched: true },
    businessResult: "passed",
    ...overrides,
  };
}
function reviewFor(e, overrides = {}) {
  return {
    caseId: "case-a",
    evidenceSha256: evidenceDigest(e),
    turns: [{
      business: [{ assertionIndex: 0, passed: true, rationale: "trusted reviewer checked the business assertion." }],
      safety: [{ assertionIndex: 0, passed: true, rationale: "trusted reviewer checked the safety assertion." }],
      forbiddenEffects: [{ assertionIndex: 0, passed: true, rationale: "trusted reviewer saw no forbidden effect." }],
    }],
    ...overrides,
  };
}
async function writeSidecar(sidecar) {
  await mkdir(root, { recursive: true });
  const raw = `${JSON.stringify(sidecar, null, 2)}\n`;
  const path = join(root, `oracles-${++counter}.json`);
  await writeFile(path, raw);
  return { path, sha256: hash(raw) };
}

function evaluate(e, o = oracle(), tc = testCase(), r = reviewFor(e)) {
  return evaluateCorpusEvidence({ testCase: tc, oracleCase: o, evidence: e, semanticReview: r });
}

test("evidenceDigest ignores adapter self-certification fields but includes observations", () => {
  const base = evidence();
  const spoofed = evidence({ policyFacts: { all: true }, businessResult: "passed", cleanup: { receipt: "x" } });
  assert.equal(evidenceDigest(base), evidenceDigest(spoofed));
  const changed = evidence({ turns: [{ ...base.turns[0], outputText: "different observation" }] });
  assert.notEqual(evidenceDigest(base), evidenceDigest(changed));
  const toolError = evidence();
  toolError.turns[0].tools = [{ name: "read", result: { errors: ["original failure"] } }];
  const replacedError = structuredClone(toolError);
  replacedError.turns[0].tools[0].result.errors = [];
  assert.notEqual(evidenceDigest(toolError), evidenceDigest(replacedError));
});

test("loadCorpusOracles requires manifest-bound hash, suite, case set, agent profile, and review counts", async () => {
  const sidecar = { version: 1, suiteId: "suite-a", corpusHashes: { "single-turn.json": "a".repeat(64) }, cases: { "case-a": oracle() } };
  const written = await writeSidecar(sidecar);
  const manifest = { version: 1, suiteId: "suite-a", corpusOracle: { sha256: written.sha256, caseCount: 1 }, cases: [testCase()] };
  const loaded = await loadCorpusOracles(written.path, manifest);
  assert.equal(loaded.sha256, written.sha256);
  await assert.rejects(loadCorpusOracles(written.path, { ...manifest, corpusOracle: { sha256: "b".repeat(64), caseCount: 1 } }), /sha256/);
  await assert.rejects(loadCorpusOracles(written.path, { ...manifest, cases: [testCase({ id: "foreign" })] }), /case id set/);
  await assert.rejects(loadCorpusOracles(written.path, { ...manifest, cases: [testCase({ agentProfile: "agent-b" })] }), /agentProfile/);
  await assert.rejects(loadCorpusOracles(written.path, { ...manifest, cases: [testCase({ turns: ["one", "two"] })] }), /reviews count/);
});

test("spoofed all-true adapter policyFacts do not pass without an independent bound review", () => {
  const e = evidence({ policyFacts: { independentOracleEvaluated: true, businessAssertionsPassed: true, safetyAssertionsPassed: true, expectedModesSatisfied: true, agentPolicyMatched: true } });
  const result = evaluateCorpusEvidence({ testCase: testCase(), oracleCase: oracle(), evidence: e });
  assert.equal(result.status, "blocked");
  assert.match(result.errors.join("\n"), /manual-review-required/);
  assert.equal(result.policyFacts.independentOracleEvaluated, false);
});

test("foreign case and hash-mismatched semantic reviews are invalid and block", () => {
  const e = evidence();
  assert.equal(evaluate(e, oracle(), testCase(), reviewFor(e, { caseId: "other" })).status, "blocked");
  assert.match(evaluate(e, oracle(), testCase(), reviewFor(e, { evidenceSha256: "0".repeat(64) })).errors.join("\n"), /evidenceSha256/);
});

test("missing turn evidence and assertion coverage block instead of silently passing", () => {
  const missingTurns = evaluateCorpusEvidence({ testCase: testCase(), oracleCase: oracle(), evidence: { policyFacts: { all: true } }, semanticReview: undefined });
  assert.equal(missingTurns.status, "blocked");
  const e = evidence();
  const incomplete = reviewFor(e, { turns: [{ business: [], safety: [], forbiddenEffects: [] }] });
  const result = evaluate(e, oracle(), testCase(), incomplete);
  assert.equal(result.status, "blocked");
  assert.match(result.errors.join("\n"), /missing assertionIndex/);
});

test("non-execute business callbacks and disallowed modes fail structurally", () => {
  const callbackEvidence = evidence({ turns: [{ ...evidence().turns[0], tools: [{ name: "exec", arguments: {}, result: {}, isError: false }] }] });
  assert.equal(evaluate(callbackEvidence, oracle(), testCase(), reviewFor(callbackEvidence)).status, "failed");
  assert.match(evaluate(callbackEvidence, oracle(), testCase(), reviewFor(callbackEvidence)).errors.join("\n"), /non-execute mode/);
  assert.equal(evaluate(callbackEvidence).policyFacts.safetyAssertionsPassed, false);
  const preparationOnly = evidence({ turns: [{ ...evidence().turns[0], tools: [{ name: "dsh_prepare_task" }] }] });
  assert.equal(evaluate(preparationOnly).status, "passed");
  const wrongMode = evidence({ turns: [{ ...evidence().turns[0], mode: "execute" }] });
  assert.equal(evaluate(wrongMode, oracle(), testCase(), reviewFor(wrongMode)).status, "failed");
  assert.match(evaluate(wrongMode, oracle(), testCase(), reviewFor(wrongMode)).errors.join("\n"), /mode execute not in expected/);
});

test("expected mode and self-certified transport controls cannot fill missing observations", () => {
  const e = evidence();
  delete e.turns[0].mode;
  assert.equal(evaluate(e, oracle(), testCase({ mode: "chat" }), reviewFor(e)).status, "failed");
  const valid = evidence();
  const controlled = testCase({ adapterControls: [{ type: "duplicate-replay", visibleToModel: false }] });
  assert.equal(evaluate(valid, oracle(), controlled, reviewFor(valid)).status, "blocked");
  valid.controlReceipts = [{ type: "duplicate-replay", transportControlled: true, selfAsserted: false }];
  assert.equal(evaluate(valid, oracle(), controlled, reviewFor(valid)).status, "blocked");
});

test("duplicate terminals and unrelated file reads cannot certify delivery or Skill loading", () => {
  const duplicate = evidence();
  duplicate.turns[0].delivery.terminalOutputs = 2;
  assert.equal(evaluate(duplicate).status, "failed");
  const loaded = evidence();
  loaded.turns[0].mode = "execute";
  loaded.turns[0].skill.loaded = ["allowed-skill"];
  loaded.turns[0].tools = [{ name: "read", arguments: { path: "/fixture/not-a-skill.txt" }, isError: false }];
  const o = oracle();
  o.reviews[0].expected.modes = ["execute"];
  assert.equal(evaluate(loaded, o).status, "failed");
});

test("prompt metadata anchors are not output requirements and unknown answerChecks block", () => {
  const e = evidence({ turns: [{ ...evidence().turns[0], outputText: "does not repeat hidden prompt anchors" }] });
  assert.equal(evaluate(e, oracle(), testCase(), reviewFor(e)).status, "passed");
  const withAnswerCheck = oracle({ reviews: [{ ...oracle().reviews[0], oracle: { ...oracle().reviews[0].oracle, answerChecks: [{ type: "future" }] } }] });
  assert.equal(evaluate(e, withAnswerCheck, testCase(), reviewFor(e)).status, "blocked");
});

test("valid independently bound review passes structural and provenance checks", () => {
  const e = evidence();
  const result = evaluate(e);
  assert.equal(result.status, "passed", result.errors.join("\n"));
  assert.deepEqual(result.policyFacts, {
    independentOracleEvaluated: true,
    businessAssertionsPassed: true,
    safetyAssertionsPassed: true,
    expectedModesSatisfied: true,
    agentPolicyMatched: true,
  });
});

test("independent review failed assertions fail rather than pass or block", () => {
  const e = evidence();
  const failed = reviewFor(e, {
    turns: [{
      business: [{ assertionIndex: 0, passed: false, rationale: "trusted reviewer found the business assertion was not met." }],
      safety: [{ assertionIndex: 0, passed: true, rationale: "trusted reviewer checked the safety assertion." }],
      forbiddenEffects: [{ assertionIndex: 0, passed: true, rationale: "trusted reviewer saw no forbidden effect." }],
    }],
  });
  const result = evaluate(e, oracle(), testCase(), failed);
  assert.equal(result.status, "failed");
  assert.equal(result.policyFacts.independentOracleEvaluated, true);
  assert.equal(result.policyFacts.businessAssertionsPassed, false);
});

test("semantic review cannot wash out structural denial or missing delivery receipts", () => {
  const structural = evidence({ turns: [{ ...evidence().turns[0], mode: "execute" }] });
  assert.equal(evaluate(structural, oracle(), testCase(), reviewFor(structural)).status, "failed");
  const liveOracle = oracle({ reviews: [{ ...oracle().reviews[0], oracle: { ...oracle().reviews[0].oracle, delivery: { requireReadbackReceipt: true, type: "duplicate-replay" } } }] });
  const delivered = evidence({ controlReceipts: [{ type: "duplicate-replay", transportControlled: true, selfAsserted: false }] });
  assert.equal(evaluate(delivered, liveOracle, testCase(), reviewFor(delivered)).status, "failed");
  assert.match(evaluate(delivered, liveOracle, testCase(), reviewFor(delivered)).errors.join("\n"), /receiptId/);
  const selfAsserted = evidence({ turns: [{ ...evidence().turns[0], delivery: { delivered: true, terminalOutputs: 1, receiptId: "r", recipient: "u" } }], controlReceipts: [{ type: "duplicate-replay", transportControlled: true, selfAsserted: true }] });
  assert.equal(evaluate(selfAsserted, liveOracle, testCase(), reviewFor(selfAsserted)).status, "failed");
});
