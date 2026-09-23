import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectState } from "../scripts/inspect-state.mjs";

test("recovery inspection preserves locks and omits credentials, message bodies and route fingerprints", async (t) => {
  const root = resolve("artifacts", `inspect-state-${randomUUID()}`);
  const key = createHash("sha256").update("synthetic").digest("hex");
  const directory = join(root, key);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(directory, "binding.json"), JSON.stringify({ status: "ready", lastRunId: "run",
    modelRoute: "PRIVATE_ROUTE", taskPreparation: { text: "PRIVATE_MESSAGE" } }));
  const owner = JSON.stringify({ pid: process.pid, runId: "run", processInstance: "instance" });
  await writeFile(join(directory, "source-reply.lock"), owner);
  await writeFile(join(directory, "source-reply-receipt.json"), JSON.stringify({ state: "unknown-after-started",
    runId: "run", message: "PRIVATE_MESSAGE", apiKey: "PRIVATE_KEY" }));
  const result = await inspectState(root);
  assert.equal(result.readOnly, true);
  assert.equal(result.records[0].disposition, "operator-inspection-required");
  assert.equal(result.records[0].sourceReply.state, "unknown-after-started");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ROUTE|PRIVATE_MESSAGE|PRIVATE_KEY/);
  assert.equal(await readFile(join(directory, "source-reply.lock"), "utf8"), owner);
});

test("recovery inspection projects only bounded failure phase codes without changing the binding", async (t) => {
  const root = resolve("artifacts", `inspect-state-${randomUUID()}`);
  const directory = join(root, createHash("sha256").update("blocked-preparation").digest("hex"));
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(directory, "binding.json");
  for (const reason of ["preparation-failed", "PRIVATE_CALLBACK_TEXT"]) {
    const value = JSON.stringify({
      status: "blocked", lastRunId: "failed-run",
      failureDiagnostic: { version: 1, operation: "run", phase: "run", reason,
        detail: "PRIVATE_KEY", preparation: {
          requested: true, resolved: false, failed: true, phase: "callback",
          arguments: "PRIVATE_MESSAGE",
        } },
    });
    await writeFile(path, value);
    const result = await inspectState(root);
    assert.equal(result.records[0].disposition, "operator-inspection-required");
    assert.deepEqual(result.records[0].failureDiagnostic.preparation, {
      requested: true, resolved: false, failed: true, phase: "callback",
    });
    assert.equal(result.records[0].failureDiagnostic.reason,
      reason === "preparation-failed" ? reason : "unrecognized");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CALLBACK_TEXT|PRIVATE_KEY|PRIVATE_MESSAGE/);
    assert.equal(await readFile(path, "utf8"), value);
  }
});
