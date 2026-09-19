import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPrompt, createGatewayCorpusReviewer, parseReviewLines } from "../scripts/lib/gateway-corpus-reviewer.mjs";
import { evidenceDigest } from "../scripts/lib/acceptance-oracles.mjs";

const input = () => ({
  testCase: { id: "unit", prompt: "Synthetic task" },
  oracleCase: { reviews: [{ expected: { modes: ["chat"] }, oracle: {
    businessAssertions: ["must match source"], safetyAssertions: ["no action"], forbiddenEffects: ["no write"],
    modelVisibleRequiredTokens: ["PROMPT-ANCHOR-NOT-ANSWER-CHECK"],
  } }] },
  fixtureGroundTruth: { table: { expectedCount: 17 } },
  evidence: { turns: [{ outputText: "UNTRUSTED-OUTPUT", tools: [], mode: "chat" }], sideEffects: [] },
});
const usage = { modelRequests: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0,
  cacheWriteTokens: 0, userTurns: 0, toolCalls: 0, priced: false };

test("reviewer receives ground truth separately and does not treat prompt anchors as answer requirements", () => {
  const prompt = buildReviewPrompt({ ...input(), authorizationGroundTruth: { resources: {
    "private-feishu-canary-map": { scope: "dedicated synthetic test chat", chatId: "synthetic-test-recipient" },
  } } });
  assert.match(prompt, /expectedCount/);
  assert.match(prompt, /untrusted_test_evidence/);
  assert.match(prompt, /UNTRUSTED-OUTPUT/);
  assert.doesNotMatch(prompt, /PROMPT-ANCHOR-NOT-ANSWER-CHECK/);
  assert.match(prompt, /synthetic-test-recipient/);
});

test("independent review uses isolated completion and binds the original observations hash", async () => {
  let seen;
  const reviewer = await createGatewayCorpusReviewer({ async complete(prompt) {
    seen = prompt;
    return { text: ["business", "safety", "forbiddenEffects"].map((category) =>
      JSON.stringify({ turn: 0, category, assertionIndex: 0, passed: true, rationale: "Observed synthetic evidence." })).join("\n"),
      usage, zeroToolsEnforced: true, receipt: { kind: "unit-isolated" } };
  } });
  const source = input();
  const result = await reviewer.reviewCase(source, { runId: "dut-run" });
  assert.match(seen, /Independent|independent/);
  assert.equal(result.evidenceSha256, evidenceDigest(source.evidence));
  assert.equal(result.caseId, "unit");
  assert.equal(result.reviewer.kind, "unit-isolated");
});

test("review lines must be complete records, not partial JSON or a silently repaired envelope", () => {
  assert.throws(() => parseReviewLines('{"turn":0', 1), SyntaxError);
  assert.throws(() => parseReviewLines('{"turns":[]}', 1), /invalid assertion/);
  const line = JSON.stringify({ turn: 0, category: "business", assertionIndex: 0, passed: false, rationale: "Not supported." });
  assert.equal(parseReviewLines(line, 1)[0].business[0].passed, false);
});

test("a reviewer that executes a business tool cannot certify a case", async () => {
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    return { text: '{"turns":[]}', zeroToolsEnforced: false, usage: { ...usage, toolCalls: 1 } };
  } });
  await assert.rejects(reviewer.reviewCase(input(), { runId: "dut" }), /enforce zero tools/);
});
