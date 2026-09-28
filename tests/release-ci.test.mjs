import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateGate, prepareLinuxStage, sdkCompanionPaths, sdkTransportRequirement, verifyRepack } from "../scripts/release-ci.mjs";
import reporter, { CAMPAIGN_FILES, verifyLinuxCoverage } from "../scripts/lib/release-test-reporter.mjs";
import { campaignEnvironment } from "./fixtures/campaign-environment.mjs";
import { approvedSdkSource, downloadSdkBytes } from "../scripts/release-sdk.mjs";
import { APPROVED_SDK_SHA256 } from "../scripts/lib/release-manifest.mjs";

test("Linux aggregate requires all expected matrix results, never skipped/cancelled/failed SDK", () => {
  for (const fixtures of ["success", "failure", "cancelled", "skipped", "", undefined]) {
    for (const sdk of ["success", "failure", "cancelled", "skipped", "", undefined]) {
      assert.equal(evaluateGate("workflow_dispatch", fixtures, sdk).ok, fixtures === "success" && sdk === "success");
      const pr = evaluateGate("pull_request", fixtures, sdk);
      assert.equal(pr.ok, fixtures === "success" && sdk === "skipped");
      assert.equal(pr.sdkAcceptance, false);
    }
  }
  assert.equal(evaluateGate("push", "success", "success").ok, false);
  assert.equal(evaluateGate("workflow_dispatch", "success", "success").sdkAcceptance, true);
});

test("repeat-pack evidence refuses mismatched bytes and does not claim independent build reproducibility", () => {
  const report = verifyRepack("a".repeat(64), "a".repeat(64));
  assert.equal(report.ok, true);
  assert.equal(report.independentBuildsCompared, false);
  assert.throws(() => verifyRepack("a".repeat(64), "b".repeat(64)));
  assert.throws(() => verifyRepack("", ""));
});

test("Linux full SDK runs cannot silently omit isolated transport coverage", () => {
  for (const optIn of [undefined, "", "0", "true"]) {
    assert.throws(() => sdkTransportRequirement("linux", optIn), /must be explicitly enabled/);
  }
  assert.equal(sdkTransportRequirement("linux", "1"), true);
  assert.equal(sdkTransportRequirement("win32", undefined), false);
  assert.equal(sdkTransportRequirement("win32", "1"), false);
});

test("campaign selection depends on explicit configuration, not host filesystem probes", () => {
  for (const root of [undefined, ""]) assert.throws(() => campaignEnvironment("linux", root), /refusing to skip/);
  assert.throws(() => campaignEnvironment("linux", "relative"), /must be absolute/);
  const absent = join(tmpdir(), "deliberately-absent-campaign-root");
  assert.deepEqual(campaignEnvironment("linux", absent), { root: absent, skip: false });
  assert.match(campaignEnvironment("win32", undefined).skip, /explicit DSH_CAMPAIGN_TEST_ROOT/);
});

test("Linux SDK staging creates fresh writable 0700 directories without chmod on existing paths", {
  skip: process.platform !== "linux" && "Linux-only private stage contract",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-private-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [stage, campaign] of [[undefined, undefined], ["relative", "relative/campaign-tests"],
    [join(root, "one"), join(root, "outside")]]) {
    assert.throws(() => prepareLinuxStage(stage, campaign), /explicit absolute/);
  }
  for (const mask of [0o022, 0o077]) {
    const previous = process.umask(mask);
    try {
      const stage = join(root, `stage-${mask}`);
      const campaign = join(stage, "campaign-tests");
      assert.equal(prepareLinuxStage(stage, campaign), stage);
      for (const path of [stage, campaign]) assert.equal(lstatSync(path).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(campaign), []);
      assert.throws(() => prepareLinuxStage(stage, campaign), { code: "EEXIST" });
    } finally { process.umask(previous); }
  }
  const external = join(root, "external");
  mkdirSync(external, { mode: 0o755 });
  const before = lstatSync(external).mode;
  const link = join(root, "link");
  symlinkSync(external, link);
  assert.throws(() => prepareLinuxStage(link, join(link, "campaign-tests")), { code: "EEXIST" });
  assert.throws(() => prepareLinuxStage(join(link, "child"), join(link, "child", "campaign-tests")), /symlinks/);
  assert.equal(lstatSync(external).mode, before);
  assert.deepEqual(readdirSync(external), []);
});

function coverageFixture() {
  return {
    counts: { tests: 322, passed: 321, failed: 0, cancelled: 0, todo: 0, skipped: 1 },
    skips: [{ file: "runtime-failure.test.mjs",
      name: "Windows rejects an overlong child cwd before spawning or creating a binding" }],
    campaign: Object.fromEntries(CAMPAIGN_FILES.map((file) => [file, 107])),
  };
}

test("Linux coverage gate fails closed on excess or unapproved skips and missing campaign coverage", () => {
  assert.equal(verifyLinuxCoverage(coverageFixture()).maxSkipped, 1);
  for (const mutate of [
    (r) => { r.counts = null; },
    (r) => { r.counts.skipped = 322; r.counts.passed = 0; },
    (r) => { r.counts.failed = 1; },
    (r) => { r.counts.cancelled = 1; },
    (r) => { r.counts.todo = 1; },
    (r) => { r.skips[0].file = CAMPAIGN_FILES[0]; },
    (r) => { r.skips[0].name = "missing SDK fixture"; },
    (r) => { r.skips = []; },
    (r) => { r.campaign[CAMPAIGN_FILES[0]] = 0; },
    (r) => { r.campaign[CAMPAIGN_FILES[0]] = 106; },
  ]) {
    const report = coverageFixture();
    mutate(report);
    assert.throws(() => verifyLinuxCoverage(report), /coverage failed/);
  }
  assert.throws(() => verifyLinuxCoverage(undefined), /coverage failed/);
});

test("coverage reporter counts only executed campaign passes and the global test summary", async () => {
  const events = [
    { type: "test:pass", data: { file: CAMPAIGN_FILES[0], name: "executed" } },
    { type: "test:pass", data: { file: CAMPAIGN_FILES[0], name: "not executed", skip: "missing root" } },
    { type: "test:fail", data: { file: CAMPAIGN_FILES[1], name: "failed" } },
    { type: "test:pass", data: { file: CAMPAIGN_FILES[2], name: "not implemented", todo: true } },
    { type: "test:summary", data: { file: CAMPAIGN_FILES[0], counts: { tests: 2 } } },
    { type: "test:summary", data: { counts: coverageFixture().counts } },
  ];
  let output = "";
  for await (const text of reporter(events)) output += text;
  const report = JSON.parse(output);
  assert.deepEqual(report.counts, coverageFixture().counts);
  assert.deepEqual(Object.values(report.campaign), [1, 0, 0]);
  assert.deepEqual(report.skips, [{ file: CAMPAIGN_FILES[0], name: "not executed" }]);
  assert.throws(() => verifyLinuxCoverage(report), /coverage failed/);
});

test("native Node test runner reports real pass/fail/skip counters to the coverage reporter", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-reporter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "probe.test.mjs");
  writeFileSync(file, `import test from "node:test";
test("pass", () => {});
test("skipped", { skip: "fixture" }, () => {});
test("fail", () => { throw Error("expected reporter probe"); });
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test",
    `--test-reporter=${new URL("../scripts/lib/release-test-reporter.mjs", import.meta.url).href}`, file],
  { encoding: "utf8", env });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.tests, 3);
  assert.equal(report.counts.passed, 1);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.skipped, 1);
  assert.deepEqual(report.skips, [{ file: "probe.test.mjs", name: "skipped" }]);
});

test("SDK checks include chat-final-text as required and group-readonly when present", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const required = ["", "compact-auth", "source-reply", "table-policy", "chat-final-text"];
  assert.deepEqual(sdkCompanionPaths(root),
    [...required, "group-readonly"].map((name) => join(root, "host-patch", name, "apply.mjs")));
  const absentRoot = join(root, "tests");
  assert.deepEqual(sdkCompanionPaths(absentRoot),
    required.map((name) => join(absentRoot, "host-patch", name, "apply.mjs")));
  const source = readFileSync(new URL("../scripts/release-ci.mjs", import.meta.url), "utf8");
  assert.match(source, /for \(const companion of sdkCompanionPaths\(\)\)/);
  assert.match(source, /\[companion, "--root", target, "--check"\]/);
});

test("SDK allowlist accepts verified fixed npm source or official release/artifact plus exact pin", () => {
  const api = "https://api.github.com/repos/openclaw/openclaw/actions/artifacts/123/zip";
  for (const url of [
    api, api.replace("/zip", ""), "https://github.com/openclaw/openclaw/actions/runs/456/artifacts/123",
    "https://api.github.com/repos/openclaw/openclaw/actions/runs/456/artifacts/123",
  ]) {
    assert.deepEqual(approvedSdkSource(url, APPROVED_SDK_SHA256), { url: api, kind: "zip" });
  }
  const release = "https://github.com/openclaw/openclaw/releases/download/v-fixture/sdk.tgz";
  assert.deepEqual(approvedSdkSource(release, APPROVED_SDK_SHA256.toUpperCase()), { url: release, kind: "tgz" });
  const npm = "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.2.tgz";
  assert.deepEqual(approvedSdkSource(npm, APPROVED_SDK_SHA256), { url: npm, kind: "tgz" });
  for (const url of [
    release.replace("https:", "http:"), release.replace("github.com", "untrusted.example"),
    release.replace("/openclaw/openclaw/", "/ericzhaouu/dsh-native/"),
    `${release}?token=generated-sentinel`, `${release}?unrecognized=1`, `${release}#fragment`,
    release.replace("https://", "https://fixture:generated-sentinel@"), `${release}.zip`,
    npm.replace("2026.9.2", "2026.9.3"), npm.replace("registry.npmjs.org", "mirror.example"),
    `${npm}?token=fixture`, npm.replace("https://", "https://user:password@"),
  ]) assert.throws(() => approvedSdkSource(url, APPROVED_SDK_SHA256));
  assert.throws(() => approvedSdkSource(release, "0".repeat(64)));
  assert.throws(() => approvedSdkSource(release));
});

test("public registry SDK requests never carry an artifact token", async () => {
  const source = approvedSdkSource("https://registry.npmjs.org/openclaw/-/openclaw-2026.9.2.tgz", APPROVED_SDK_SHA256);
  const calls = [];
  await downloadSdkBytes(source, "fixture-not-a-real-token", async (url, options) => {
    calls.push({ url, options });
    return new Response("synthetic sdk bytes");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test("SDK redirects strip authorization and reject downgrade without a network request", async () => {
  const source = approvedSdkSource("https://api.github.com/repos/openclaw/openclaw/actions/artifacts/123/zip", APPROVED_SDK_SHA256);
  const calls = [];
  const result = await downloadSdkBytes(source, "generated-fixture-token", async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/generated-fixture" } })
      : new Response("generated artifact");
  });
  assert.equal(result.toString(), "generated artifact");
  assert.equal(calls[0].options.headers.Authorization, "Bearer generated-fixture-token");
  assert.equal(calls[1].options.headers.Authorization, undefined);
  let requests = 0;
  await assert.rejects(downloadSdkBytes(source, "generated-fixture-token", async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: "http://untrusted.example/" } });
  }), /Unsafe SDK redirect/);
  assert.equal(requests, 1);
  await assert.rejects(downloadSdkBytes(source, "", async () => {
    throw new Error("generated-secret-sentinel");
  }), (error) => !error.message.includes("generated-secret-sentinel"));
});

test("workflow keeps required Linux independent from Windows and uploads exact nonsecret files", () => {
  const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  const jobs = new Map([...workflow.matchAll(/^  ([a-z][a-z-]+):\r?\n([\s\S]*?)(?=^  [a-z][a-z-]+:\r?\n|(?![\s\S]))/gm)]
    .map((match) => [match[1], match[2]]));
  for (const key of ["package-acceptance", "full-sdk-acceptance"]) {
    assert.match(jobs.get(key), /runs-on: ubuntu-24\.04/);
    assert.match(jobs.get(key), /node: \["22\.23\.1", "24\.15\.0"\]/);
    assert.doesNotMatch(jobs.get(key), /continue-on-error/);
  }
  for (const key of ["package-windows-experimental", "full-sdk-windows-experimental"]) {
    assert.match(jobs.get(key), /continue-on-error: true/);
    assert.match(jobs.get(key), /runs-on: windows-2022/);
  }
  assert.match(jobs.get("full-sdk-acceptance"), /DSH_RUN_ISOLATED_SDK_TRANSPORT: "1"/);
  assert.match(jobs.get("full-sdk-acceptance"), /DSH_CI_PRIVATE_ROOT:.*linux-node-\$\{\{ matrix.node \}\}/);
  assert.match(jobs.get("full-sdk-acceptance"), /DSH_CAMPAIGN_TEST_ROOT:.*linux-node-\$\{\{ matrix.node \}\}\/campaign-tests/);
  assert.match(jobs.get("full-sdk-acceptance"), /artifacts\/release-evidence\/test-coverage\.json/);
  assert.doesNotMatch(jobs.get("full-sdk-windows-experimental"), /DSH_CAMPAIGN_TEST_ROOT|DSH_CI_PRIVATE_ROOT/);
  for (const key of ["full-sdk-acceptance", "full-sdk-windows-experimental"]) {
    assert.match(jobs.get(key), /run: node scripts\/release-sdk\.mjs/);
    assert.match(jobs.get(key), /run: node scripts\/release-ci\.mjs full/);
  }
  assert.doesNotMatch(jobs.get("full-sdk-windows-experimental"), /DSH_RUN_ISOLATED_SDK_TRANSPORT/);
  assert.doesNotMatch(jobs.get("package-acceptance"), /DSH_RUN_ISOLATED_SDK_TRANSPORT/);
  const gate = jobs.get("required-linux-gate");
  assert.match(gate, /needs: \[package-acceptance, full-sdk-acceptance\]/);
  assert.match(gate, /if: always\(\)/);
  assert.doesNotMatch(gate, /needs.*windows/);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|workflow_dispatch.*run|gh release|npm publish/);
  assert.equal((workflow.match(/SDK_TOKEN:/g) ?? []).length, 2);
  const uploadPaths = [...workflow.matchAll(/^\s+(?:path: )?(artifacts\/[^\r\n]+)/gm)].map((match) => match[1]);
  assert.ok(uploadPaths.length >= 9);
  for (const path of uploadPaths) {
    assert.match(path, /^artifacts\/release-evidence\/(?:fixture-results\.json|full-sdk-results\.json|test-coverage\.json|release-manifest\.json|verification\.json|reproducibility\.json|SHA256SUMS\.txt|linux-gate\.json)$/);
  }
  for (const action of [...workflow.matchAll(/uses: (actions\/[^@\s]+)@([^\s]+)/g)]) {
    assert.match(action[2], /^[a-f0-9]{40}$/);
  }
});
