import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parseArgs, summarizeNumbers } from "../scripts/run-native-soak.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "run-native-soak.mjs");

test("native soak CLI defaults to a dry-run plan without execution", () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.execute, false);
  assert.equal(summary.dryRunPassed, false);
  assert.equal(summary.plannedOnly, true);
  assert.equal(summary.realTurnCount, 0);
  assert.equal(summary.plannedTurnCount, 200);
  assert.equal(summary.wouldLaunchRuntimeOrModel, false);
});

test("native soak rejects invalid CLI and enforces the 200-turn cap", () => {
  assert.throws(() => parseArgs(["--unexpected"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--turns", "0"]), /between 1 and 200/);
  assert.throws(() => parseArgs(["--turns", "201"]), /between 1 and 200/);
  assert.throws(() => parseArgs(["--turns", "4.5"]), /between 1 and 200/);
  assert.throws(() => parseArgs(["--max-concurrent-runs", "0"]), /between 1 and 8/);
  assert.throws(() => parseArgs(["--max-concurrent-runs", "9"]), /between 1 and 8/);

  const result = spawnSync(process.execPath, [script, "--turns", "201"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /between 1 and 200/);
});

test("GC diagnostics are explicit and cannot start silently without exposed collection", () => {
  assert.equal(parseArgs(["--stability", "--gc-diagnostics"]).gcDiagnostics, true);
  const result = spawnSync(process.execPath, [script, "--execute", "--stability", "--gc-diagnostics", "--turns", "2"], {
    cwd: repoRoot, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires node --expose-gc; no work was started/);
});

test("native soak stability CLI is opt-in and keeps default compatibility", () => {
  const normal = parseArgs([]);
  assert.equal(normal.stability, false);
  assert.equal(normal.turns, 200);
  assert.equal(normal.maxConcurrentRuns, 8);

  const stability = parseArgs(["--execute", "--stability", "--turns", "4", "--max-concurrent-runs", "2"]);
  assert.equal(stability.execute, true);
  assert.equal(stability.stability, true);
  assert.equal(stability.turns, 4);
  assert.equal(stability.maxConcurrentRuns, 2);
});

test("native soak resource summaries are bounded and include percentiles for larger samples", () => {
  assert.deepEqual(summarizeNumbers([]), { count: 0 });
  assert.deepEqual(summarizeNumbers([3, 1, 2]), { count: 3, min: 1, avg: 2, max: 3 });
  const summary = summarizeNumbers(Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(summary.count, 20);
  assert.equal(summary.p50, 10);
  assert.equal(summary.p95, 19);
});

async function inspectChildFixture({ states, statuses = [{ rss: 2048, threads: 1, ppid: 1 }], denied = [] }) {
  const source = await readFile(script, "utf8");
  const code = source.slice(source.indexOf("async function inspectPid("), source.indexOf("\nfunction makeTrend("));
  let statReads = 0;
  let statusReads = 0;
  let fdReads = 0;
  const context = {
    setTimeout, parseProcStat: JSON.parse,
    parseStatusNumberKiB: (status, key) => key === "VmRSS" ? JSON.parse(status).rss : 4096,
    parseStatusNumber: (status) => JSON.parse(status).ppid,
    readProcFile: async (path) => {
      if (path.endsWith("/stat")) {
        const state = states[Math.min(statReads++, states.length - 1)];
        return state ? JSON.stringify({ state: state.state ?? "R", startTime: state.startTime ?? "123", pgrp: 1 }) : undefined;
      }
      return JSON.stringify(statuses[Math.min(statusReads++, statuses.length - 1)]);
    },
    readdir: async () => {
      const code = denied[fdReads++];
      if (code) throw Object.assign(new Error("fixture denied"), { code });
      return ["0", "1", "2"];
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { result: await vm.runInContext("inspectPid(42)", context), fdReads };
}

test("child sampler rechecks identity after FD enumeration and excludes newly exited children", async () => {
  assert.equal((await inspectChildFixture({ states: [{}, { state: "Z" }], denied: ["EACCES"] })).result, undefined);
  assert.equal((await inspectChildFixture({ states: [{}, undefined] })).result, undefined);
  assert.equal((await inspectChildFixture({ states: [{}, { startTime: "456" }] })).result, undefined);
  assert.equal((await inspectChildFixture({
    states: [{}, {}, { startTime: "456" }], denied: ["EACCES"],
  })).result, undefined);
});

test("child sampler retries transient missing RSS/FD observations without reporting false leaks", async () => {
  const sample = await inspectChildFixture({
    states: [{}], statuses: [{ ppid: 1 }, { ppid: 1, rss: 2048 }], denied: ["EACCES"],
  });
  assert.equal(sample.fdReads, 2);
  assert.equal(sample.result.fdCount, 3);
  assert.equal(sample.result.rssBytes, 2048);
});

test("child sampler bounds retries and preserves unavailable live measurements as null", async () => {
  const sample = await inspectChildFixture({
    states: [{}], statuses: [{ ppid: 1 }], denied: ["EACCES", "EPERM", "EACCES"],
  });
  assert.equal(sample.fdReads, 3);
  assert.equal(sample.result.fdCount, null);
  assert.equal(sample.result.rssBytes, null);
  await assert.rejects(inspectChildFixture({ states: [{}], denied: ["EIO"] }), /fixture denied/);
});

test("native soak smoke executes four real DSH child turns offline", { timeout: 90000 }, async () => {
  const artifactsDir = join(repoRoot, "artifacts", "externalprivate", `native-soak-test-${randomUUID()}`);
  try {
    const result = spawnSync(process.execPath, [
      script,
      "--execute",
      "--turns",
      "4",
      "--artifacts-dir",
      artifactsDir,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 90000,
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.execute, true);
    assert.equal(summary.dryRunPassed, false);
    assert.equal(summary.realTurnCount, 4);
    assert.equal(summary.toolCallbacks, 4);
    assert.equal(summary.finals, 4);
    assert.equal(summary.modelRequestCount, 8);
    assert.equal(summary.nativeBindingCount, 2);
    assert.equal(summary.ownerLockCountAfterSettlement, 0);
    assert.equal(summary.previousNativeBindingsRetainedDuringRun, true);
    assert.match(summary.privateJsonSha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof summary.resourceFacts.childRssMeasured, "boolean");
    if (process.platform !== "linux") assert.equal(summary.resourceFacts.childRssMeasured, false);
    assert.equal(summary.cleanup.completed, true);
    assert.equal(summary.cleanup.removedOwnedState, true);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
