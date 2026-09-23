import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parseDshConfig } from "../dist/config.js";
import { createDshRuntime } from "../dist/runtime.js";

async function liveProcess(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(value.slice(value.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

for (const mode of ["hang", "grandchild"]) {
  test(`Linux real child ${mode} cannot defeat cancellation by ignoring TERM`, {
    skip: process.platform !== "linux", timeout: 15000,
  }, async (t) => {
    const root = resolve("artifacts", `stability-process-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const checkpoint = join(root, "checkpoint.json");
    const actualSpawn = childProcess.spawn;
    let child;
    let metadata;
    const mocked = t.mock.method(childProcess, "spawn", (command, _args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(options.detached, true, "Only the owned DSH child gets a new process group");
      child = actualSpawn(command, [resolve("tests/fixtures/stability-worker.mjs"), mode, checkpoint], options);
      return child;
    });
    syncBuiltinESMExports();
    const runtime = createDshRuntime(parseDshConfig({ stateDir: join(root, "state"),
      startupTimeoutMs: 5000, shutdownTimeoutMs: 250 }));
    const controller = new AbortController();
    const input = { sessionId: "fault-owned", runId: randomUUID(), workspaceDir: root,
      prompt: "synthetic", systemPrompt: "synthetic", modelId: "deepseek-v4-pro", apiKey: "synthetic-key",
      baseUrl: "https://api.deepseek.com", contextWindow: 1000000, thinking: "disabled", tools: [],
      signal: controller.signal, assertActive() {}, onEvent() {}, async executeTool() { assert.fail("No tools"); } };
    const work = runtime.run(input);
    const rejected = assert.rejects(work, /cancel|exit|termination|terminated/i);
    try {
      const deadline = Date.now() + 7000;
      while (!metadata && Date.now() < deadline) {
        try { metadata = JSON.parse(await readFile(checkpoint, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!metadata) await new Promise((done) => setTimeout(done, 25));
      }
      assert.ok(metadata, "Real child must reach its run handler");
      const started = performance.now();
      const realDateNow = Date.now;
      let reads = 0;
      Date.now = () => realDateNow() + (++reads > 1 ? 60_000 : 0);
      try {
        controller.abort(new Error("Synthetic runtime cancellation"));
        await rejected;
      } finally {
        Date.now = realDateNow;
      }
      assert.ok(performance.now() - started < 3000, "Cancellation must finish with a bounded terminal result");
      assert.equal(await liveProcess(metadata.pid), false);
      if (metadata.descendant) assert.equal(await liveProcess(metadata.descendant), false);
      const binding = JSON.parse(await readFile(join(root, "state",
        createHash("sha256").update(input.sessionId).digest("hex"), "binding.json"), "utf8"));
      assert.equal(binding.status, "blocked", "Cancellation must never mark unknown native work ready");
    } finally {
      controller.abort();
      if (child?.pid && await liveProcess(child.pid)) process.kill(-child.pid, "SIGKILL");
      if (metadata?.descendant && await liveProcess(metadata.descendant)) process.kill(metadata.descendant, "SIGKILL");
      try { await runtime.dispose(); }
      catch (error) { assert.equal(error.code, "DSH_TERMINATION_UNCONFIRMED"); }
      mocked.mock.restore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}
