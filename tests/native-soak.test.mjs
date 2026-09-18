import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../scripts/run-native-soak.mjs";

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

  const result = spawnSync(process.execPath, [script, "--turns", "201"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /between 1 and 200/);
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
    assert.equal(summary.resourceFacts.childRssMeasured, false);
    assert.equal(summary.cleanup.completed, true);
    assert.equal(summary.cleanup.removedOwnedState, true);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
