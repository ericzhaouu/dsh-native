import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateGate, sdkCompanionPaths, sdkTransportRequirement, verifyRepack } from "../scripts/release-ci.mjs";
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
    assert.match(path, /^artifacts\/release-evidence\/(?:fixture-results\.json|full-sdk-results\.json|release-manifest\.json|verification\.json|reproducibility\.json|SHA256SUMS\.txt|linux-gate\.json)$/);
  }
  for (const action of [...workflow.matchAll(/uses: (actions\/[^@\s]+)@([^\s]+)/g)]) {
    assert.match(action[2], /^[a-f0-9]{40}$/);
  }
});
