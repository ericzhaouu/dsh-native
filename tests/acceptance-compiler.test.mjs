import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { compileAcceptance, compileCorpus } from "../scripts/compile-acceptance.mjs";
import { compileManifestValidator, loadManifest } from "../scripts/lib/acceptance-contract.mjs";
import { assertCaseExpectation } from "../scripts/lib/acceptance-expectations.mjs";
import { loadCorpusOracles } from "../scripts/lib/acceptance-oracles.mjs";
import {
  acceptanceByteContract,
  materializeAcceptanceCorpusBytes,
  materializeAcceptanceFixtureBytes,
  readAcceptanceCorpusBytes,
} from "../scripts/lib/acceptance-source-bytes.mjs";

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

test("reviewed acceptance byte contract preserves v1 CRLF corpus and LF fixtures", async () => {
  for (const [name, contract] of Object.entries(acceptanceByteContract.v1Corpus)) {
    const raw = await readFile(new URL(`./acceptance/cases/${name}`, import.meta.url));
    const materialized = materializeAcceptanceCorpusBytes(name, raw);
    assert.equal(createHash("sha256").update(materialized).digest("hex"), contract.materialized);
    assert.equal(createHash("sha256").update(materializeAcceptanceCorpusBytes(name,
      Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8"))).digest("hex"), contract.materialized);
    assert.throws(() => materializeAcceptanceCorpusBytes(name, Buffer.concat([raw, Buffer.from(" ")])),
      /Acceptance byte contract mismatch/);
  }
  for (const [name, contract] of Object.entries(acceptanceByteContract.fixtures)) {
    const raw = await readFile(new URL(`./fixtures/acceptance/${name}`, import.meta.url));
    const materialized = materializeAcceptanceFixtureBytes(name, raw);
    assert.equal(createHash("sha256").update(materialized).digest("hex"), contract.materialized);
    assert.equal(createHash("sha256").update(materializeAcceptanceFixtureBytes(name,
      Buffer.from(raw.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8"))).digest("hex"), contract.materialized);
    assert.throws(() => materializeAcceptanceFixtureBytes(name, Buffer.concat([raw, Buffer.from(" ")])),
      /Acceptance byte contract mismatch/);
  }
});

test("default and explicit source v1 retain every historical subset and the 12-case pilot payload", async () => {
  const hashes = {
    all: [
      ["edb16464f1d2955cb180c80a3a3198c1e8ecbc0da410fdbc46667b9c03e6d0cb", "a7999c57b00e6788d5959efba761f01eab4d4eec6ae1b262e98f5e7a69aeaf17"],
      ["993731dbd4fda8fef3b8a01e486f3e0f27ef6995bd23e6303ace6faf9863705e", "78c5a492e13847f0df779d437f44b17f4b25448b521e451d2d87e758f3714e04"],
    ],
    single: [
      ["1002163af3c2b77f9254d7cc20099bce923612764a0ef8af71e7f06fd04662c4", "a6a3c3d2d5b50510197f44c94f005d5f0bc95c0edf4b5ccc7b71d84a97bfe825"],
      ["516f646f8142e907443966c6932f881895dd63c03455cc32af85f0357d3fc24f", "49d7bb55f1409cad2d63da9b097a98e7c19366443f8a5a749acc0c44388a6a0f"],
    ],
    multi: [
      ["3f19c7b61f83c6f72f584a334980b8b00da6d8512f8d0ad9b870a9e03b33b128", "7eca2a9693e3160986bf7d06a9f0d61dd2ffd48b535000141af28be988758ac2"],
      ["d686500df1b9eda4ed79525f81c3b82e16ad679fc652c228fcd0fc26231cd764", "009a143a6fd861152d9f64b48930d4dcab3c4c6dec9c6975393e3fba7e0b9bed"],
    ],
    canary: [
      ["550f4976cdef1a6db7cbe455b5c90fedbffd104258b2a4bfda132d8e2c58c2e2", "9febc72a2aa6f87cb64c3b40e96b1e25891e1c3a54a03ee4a6923cf5ef3d2d40"],
      ["3e92c350e5b8affd642256a62a0a10d394363777e24a495d9b6933fff5abf623", "1daafbe14926173a307271aa64016ec3435b9db5035f49eb9ba85004175f0551"],
    ],
  };
  const pilotHashes = [
    "18fc92efde6865ace1e577ffaee0f180a5cdeedb0c3215e8157f876752911fa7",
    "8d1fac7bf58d7985899cfa0378d7f3cb14aed581c4496fc9d884f2a415c58b66",
  ];
  const hash = (value) => createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
  for (const subset of Object.keys(hashes)) {
    for (const contractVersion of [1, 2]) {
      const historical = await compileCorpus({ subset, contractVersion });
      const explicit = await compileCorpus({ subset, contractVersion, sourceCorpusVersion: 1 });
      assert.deepEqual(explicit, historical);
      assert.equal(hash(historical.manifest), hashes[subset][contractVersion - 1][0]);
      assert.equal(hash(historical.oracles), hashes[subset][contractVersion - 1][1]);
      if (subset === "all") {
        const cases = historical.manifest.cases.filter((item) =>
          /^st-dsh-(assistant|partner)-(02|05|06|08|14|15)-.*-v1$/.test(item.id));
        assert.equal(cases.length, 12);
        assert.equal(hash({
          cases, oracles: Object.fromEntries(cases.map((item) => [item.id, historical.oracles.cases[item.id]])),
        }), pilotHashes[contractVersion - 1]);
      }
    }
  }
});

test("CLI help separates source selection from the expectation contract and rejects unsupported combinations", async () => {
  const help = await compileAcceptance(["--help"]);
  assert.match(help.usage, /--source-corpus-version 1\|2\|3/);
  assert.match(help.usage, /--contract-version 1\|2/);
  assert.deepEqual(help.defaults, { sourceCorpusVersion: 1, contractVersion: 2 });
  assert.equal(help.sourceVersions[2], "approved-v2");
  assert.equal(help.sourceVersions[3], "approved-v3");
  assert.deepEqual(await compileAcceptance(["-h"]), help);
  for (const sourceCorpusVersion of [0, 5, "2", NaN, null]) {
    await assert.rejects(compileCorpus({ sourceCorpusVersion }), /Unsupported source corpus version/);
  }
  await assert.rejects(compileCorpus({ sourceCorpusVersion: 2, contractVersion: 1 }),
    /approved-v2 requires expectation contract version 2/);
  const unused = resolve("artifacts", `invalid-source-${randomUUID()}`);
  for (const value of ["0", "5", "unknown", undefined]) {
    await assert.rejects(compileAcceptance([
      "--output-root", unused, "--source-corpus-version", ...(value === undefined ? [] : [value]),
    ]), /Unsupported source corpus version/);
  }
});

test("explicit source v2 CLI plans distinct SHA-bound artifacts for every subset without overwriting source v1", async (t) => {
  const root = resolve("artifacts", `source-v2-compiler-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldOutput = resolve(root, "historical-default");
  const old = await compileAcceptance(["--output-root", oldOutput]);
  const oldManifest = await readFile(old.manifestPath);
  const oldOracles = await readFile(old.oraclePath);
  assert.equal(old.sourceCorpusVersion, "approved1.0testplan.acceptanceCorpus.v1");
  for (const [subset, cases, submissions] of [["all", 200, 224], ["single", 180, 180], ["multi", 8, 32], ["canary", 12, 12]]) {
    const result = await compileAcceptance([
      "--output-root", resolve(root, subset), "--subset", subset, "--source-corpus-version", "2",
    ]);
    assert.equal(result.status, "planned");
    assert.equal(result.cases, cases);
    assert.equal(result.submissions, submissions);
    assert.equal(result.sourceCorpusVersion, "approved-v2");
    assert.equal(result.contractVersion, 2);
    assert.equal(result.suiteId, `dsh-v2-approved-v2-${subset}`);
    const { manifest } = await loadManifest(result.manifestPath);
    const sidecar = await loadCorpusOracles(result.oraclePath, manifest);
    assert.equal(sidecar.sourceCorpusVersion, "approved-v2");
    assert.equal(manifest.version, 2);
    assert.equal(sidecar.version, 2);
    for (const [name, sha256] of Object.entries(sidecar.corpusHashes)) {
      const bytes = await readAcceptanceCorpusBytes(new URL(`./acceptance/cases/${name}`, import.meta.url), name);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
    }
    manifest.cases.forEach(assertCaseExpectation);
  }
  await assert.rejects(compileAcceptance([
    "--output-root", oldOutput, "--source-corpus-version", "2",
  ]), /EEXIST/);
  assert.deepEqual(await readFile(old.manifestPath), oldManifest);
  assert.deepEqual(await readFile(old.oraclePath), oldOracles);
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
