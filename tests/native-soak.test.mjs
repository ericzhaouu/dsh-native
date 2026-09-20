import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
