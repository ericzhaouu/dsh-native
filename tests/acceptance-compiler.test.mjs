import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { compileAcceptance, compileCorpus } from "../scripts/compile-acceptance.mjs";
import { compileManifestValidator, loadManifest } from "../scripts/lib/acceptance-contract.mjs";
import { assertCaseExpectation } from "../scripts/lib/acceptance-expectations.mjs";
import { loadCorpusOracles } from "../scripts/lib/acceptance-oracles.mjs";

test("complete corpus compiles to gated runner cases with a separate oracle sidecar", async () => {
  const { manifest, oracles, submissions } = await compileCorpus();
  assert.equal(manifest.cases.length, 188);
  assert.equal(submissions, 212);
  assert.equal(manifest.stage, "live");
  assert.equal(manifest.version, 2);
  assert.equal(oracles.version, 2);
  assert.equal(Object.keys(oracles.cases).length, 188);
  assert.equal(Object.keys(oracles.corpusHashes).length, 3);
  assert.equal(oracles.fixtures["feishu-table"].oracle.filters.all_open.resultIds.length, 17);
  assert.equal(JSON.stringify(manifest).includes('"WB-001"'), false);
  assert.equal(manifest.corpusOracle.caseCount, 188);
  assert.equal(manifest.corpusOracle.sha256,
    createHash("sha256").update(`${JSON.stringify(oracles, null, 2)}\n`).digest("hex"));
  for (const item of manifest.cases) {
    assert.equal(item.stage, "live");
    assert.ok(item.prerequisites.includes("model-budget-approved"));
    assert.ok(item.prerequisites.includes("independent-corpus-oracles-available"));
    assert.equal(item.fixtures.evidence, undefined);
    assert.equal(item.oracle, undefined);
    assert.notEqual(item.expected.executionStatus, "infrastructure_blocked");
    assert.equal(item.expected.executionStatus, undefined);
    assert.equal(item.expected.businessResult, undefined);
    assert.equal(item.mode, undefined);
    assert.equal(item.expected.contractVersion, 2);
    assert.ok(item.assertions.policyFacts.some((fact) => fact.name === "independentOracleEvaluated"));
  }
});

test("v2 preserves every allowed outcome and mode, including all 44 collapsed alternatives", async () => {
  const { manifest, oracles } = await compileCorpus();
  let dual = 0;
  for (const item of manifest.cases) {
    const reviews = oracles.cases[item.id].reviews;
    assert.deepEqual(item.expected.allowedOutcomes, reviews.at(-1).expected.permittedOutcomes);
    assert.deepEqual(item.expected.allowedModes, reviews.at(-1).expected.modes);
    assert.equal(item.expected.turnExpectations.length, item.turns?.length ?? 1);
    reviews.forEach((review, index) => {
      assert.deepEqual(item.expected.turnExpectations[index], {
        submissionId: review.submissionId, allowedOutcomes: review.expected.permittedOutcomes, allowedModes: review.expected.modes,
      });
    });
    if (item.expected.allowedOutcomes.length === 2) dual++;
    assertCaseExpectation(item);
  }
  assert.equal(dual, 42);
  assert.equal(Object.values(oracles.cases).filter((item) =>
    item.reviews.some((review) => review.expected.permittedOutcomes.includes("correctly_blocked")) &&
    item.reviews.at(-1).expected.permittedOutcomes.includes("completed")).length, 44);
});

test("legacy compile is byte-reproducible and v1 source corpus hashes remain immutable", async () => {
  const { manifest, oracles } = await compileCorpus({ contractVersion: 1 });
  const hash = (value) => createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
  assert.equal(hash(manifest), "edb16464f1d2955cb180c80a3a3198c1e8ecbc0da410fdbc46667b9c03e6d0cb");
  assert.equal(hash(oracles), "a7999c57b00e6788d5959efba761f01eab4d4eec6ae1b262e98f5e7a69aeaf17");
  assert.deepEqual(oracles.corpusHashes, {
    "single-turn.json": "b243b803327f12f2540ddf2d744cbe7e049b64024059d57a4db508dfc3991371",
    "multi-turn.json": "48eba442c548f4b4ad6454c52fb09e47131ff0729ceecd82c5d7b0661bee4b5e",
    "feishu-canary.json": "4665b07d194424c4905eb6f2513beb5296af95481709fe82608205a3b4d4cc19",
  });
  await assert.rejects(compileCorpus({ contractVersion: 3 }), /Unsupported/);
});

test("strict schema rejects mixed versions, empty/unknown/duplicate outcomes and scalar collapse", async () => {
  const { manifest } = await compileCorpus({ subset: "canary" });
  const validate = await compileManifestValidator();
  assert.equal(validate(manifest), true);
  for (const change of [
    (m) => { m.version = 1; },
    (m) => { m.cases[0].expected.executionStatus = "completed"; },
    (m) => { m.cases[0].mode = "chat"; },
    ...[[], ["infrastructure_blocked"], ["failed"], ["unknown"], ["completed", "completed"]]
      .map((outcomes) => (m) => { m.cases[0].expected.allowedOutcomes = outcomes; }),
    (m) => { m.cases[0].expected.allowedModes = ["unknown"]; },
    (m) => { m.cases[0].expected.turnExpectations = []; },
  ]) {
    const invalid = structuredClone(manifest);
    change(invalid);
    assert.equal(validate(invalid), false);
  }
  const invalid = structuredClone(manifest.cases[0]);
  invalid.expected.turnExpectations[0].allowedOutcomes = ["correctly_blocked"];
  assert.throws(() => assertCaseExpectation(invalid), /final turn/);
  invalid.expected.turnExpectations = [];
  assert.throws(() => assertCaseExpectation(invalid), /align/);
});

test("fixture scopes distinguish static claims and retain positive write prerequisites without authorizing writes", async () => {
  const { manifest, oracles } = await compileCorpus();
  const staticCases = Object.values(oracles.cases).filter((item) => item.fixtureRefs.includes("golden-search"));
  assert.ok(staticCases.length);
  for (const item of staticCases) {
    assert.equal(item.fixtureScope.fixtures.find((fixture) => fixture.id === "golden-search").evidenceKind, "static-search");
    assert.equal(item.fixtureScope.grantsWriteAuthority, false);
    assert.ok(item.reviews.every((review) => review.oracle.safetyAssertions.at(-1).includes("not live search")));
  }
  const writeCases = manifest.cases.filter((item) => item.prerequisites.includes("test-write-authorization-required"));
  assert.equal(writeCases.length, 2);
  for (const item of writeCases) {
    const scope = oracles.cases[item.id].fixtureScope;
    assert.ok(scope.requiredCapabilities.includes("authorized-test-write"));
    assert.ok(scope.requiredCapabilities.includes("live-channel-delivery"));
    assert.equal(scope.grantsWriteAuthority, false);
    assert.deepEqual(item.expected.allowedOutcomes, ["completed"]);
  }
  assert.ok(manifest.cases.every((item) => item.fixtureScope === undefined));
});

test("CLI persists both versioned contracts with verified sidecars and never overwrites existing results", async (t) => {
  const root = resolve("artifacts", `v073-compiler-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of [1, 2]) {
    const output = resolve(root, `v${version}`);
    const result = await compileAcceptance(["--output-root", output, "--contract-version", String(version), "--subset", "multi"]);
    const original = await readFile(result.manifestPath);
    const { manifest } = await loadManifest(result.manifestPath);
    const sidecar = await loadCorpusOracles(result.oraclePath, manifest);
    assert.equal(manifest.version, version);
    assert.equal(sidecar.version, version);
    assert.equal(result.cases, 8);
    assert.equal(result.submissions, 32);
    await assert.rejects(compileAcceptance(["--output-root", output]), /EEXIST/);
    assert.deepEqual(await readFile(result.manifestPath), original);
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
  assert.ok(canary.manifest.cases.every((item) => item.adapterControls?.[0]?.visibleToModel === false));
  await assert.rejects(compileCorpus({ subset: "unknown" }), /Unknown corpus/);
});
