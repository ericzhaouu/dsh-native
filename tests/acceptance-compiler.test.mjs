import assert from "node:assert/strict";
import test from "node:test";
import { compileCorpus } from "../scripts/compile-acceptance.mjs";

test("complete corpus compiles to gated runner cases with a separate oracle sidecar", async () => {
  const { manifest, oracles, submissions } = await compileCorpus();
  assert.equal(manifest.cases.length, 188);
  assert.equal(submissions, 212);
  assert.equal(manifest.stage, "live");
  assert.equal(Object.keys(oracles.cases).length, 188);
  assert.equal(Object.keys(oracles.corpusHashes).length, 3);
  for (const item of manifest.cases) {
    assert.equal(item.stage, "live");
    assert.ok(item.prerequisites.includes("model-budget-approved"));
    assert.ok(item.prerequisites.includes("independent-corpus-oracles-available"));
    assert.equal(item.fixtures.evidence, undefined);
    assert.equal(item.oracle, undefined);
    assert.notEqual(item.expected.executionStatus, "infrastructure_blocked");
    assert.ok(item.assertions.policyFacts.some((fact) => fact.name === "independentOracleEvaluated"));
  }
});

test("single cases expand into three variants while multi-turn scripts preserve conversation grouping", async () => {
  const single = await compileCorpus({ subset: "single" });
  assert.equal(single.manifest.cases.length, 168);
  assert.equal(single.submissions, 168);
  const multi = await compileCorpus({ subset: "multi" });
  assert.equal(multi.manifest.cases.length, 8);
  assert.equal(multi.submissions, 32);
  assert.ok(multi.manifest.cases.every((item) => item.kind === "multiTurn" && item.turns.length === 4));
  const canary = await compileCorpus({ subset: "canary" });
  assert.equal(canary.manifest.cases.length, 12);
  assert.ok(canary.manifest.cases.every((item) => item.prerequisites.includes("live-feishu-canary-approved")));
  await assert.rejects(compileCorpus({ subset: "unknown" }), /Unknown corpus/);
});
