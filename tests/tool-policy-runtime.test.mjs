import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseDshConfig } from "../dist/config.js";
import { createDshRuntime } from "../dist/runtime.js";
import { startModelServer } from "./fixtures/model-server.mjs";

test("selected tool policy changes require new epoch; old and unrelated bindings remain valid", { timeout: 180000 }, async () => {
  const root = resolve(".test-state", `tool-policy-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const server = await startModelServer(({ send, finish }) => {
    send({ role: "assistant", content: "fixture" }); finish();
  });
  const base = { stateDir: root, allowedBaseUrls: [server.baseUrl],
    startupTimeoutMs: 30000, shutdownTimeoutMs: 10000, streamIdleTimeoutMs: 5000 };
  const input = { agentId: "target", sessionId: "legacy", runId: "first", workspaceDir: root,
    prompt: "fixture", systemPrompt: "fixture", modelId: "deepseek-v4-pro",
    apiKey: "local-fixture-only", baseUrl: server.baseUrl, contextWindow: 1000000, maxTokens: 100,
    thinking: "disabled", tools: [], signal: new AbortController().signal, assertActive() {}, onEvent() {},
    async executeTool() { throw new Error("No actual tools"); } };
  const runtimes = [];
  const runtime = (extra) => {
    const instance = createDshRuntime(parseDshConfig({ ...base, ...extra }));
    runtimes.push(instance); return instance;
  };
  const binding = (id) => join(root, createHash("sha256").update(id).digest("hex"), "binding.json");
  try {
    const legacy = runtime({});
    await legacy.run(input);
    const old = await readFile(binding("legacy"), "utf8");
    assert.equal(JSON.parse(old).toolPolicyFingerprint, undefined);
    const scoped = runtime({ toolAllowlistByAgent: { target: ["read"] } });
    await assert.rejects(scoped.run({ ...input, nativeStateId: "invalid-surface", tools: [{
      name: "exec", description: "not permitted", parameters: { type: "object" },
    }] }), /surface exceeds/);
    await assert.rejects(scoped.run({ ...input, runId: "blocked" }), /policy changed.*\/new/);
    assert.equal(await readFile(binding("legacy"), "utf8"), old);
    await scoped.run({ ...input, nativeStateId: "new-epoch", runId: "fresh" });
    const before = await readFile(binding("new-epoch"), "utf8");
    assert.match(JSON.parse(before).toolPolicyFingerprint, /^[a-f0-9]{64}$/);
    const changed = runtime({ toolAllowlistByAgent: { target: [] } });
    await assert.rejects(changed.run({ ...input, nativeStateId: "new-epoch", runId: "changed" }), /policy changed/);
    await assert.rejects(changed.compact({ ...input, nativeStateId: "new-epoch", runId: "compact" }), /policy changed/);
    await assert.rejects(changed.recoverCompaction({ ...input, nativeStateId: "new-epoch", runId: "recover" }), /policy changed/);
    await assert.rejects(legacy.run({ ...input, nativeStateId: "new-epoch", runId: "removed" }), /policy changed/);
    assert.equal(await readFile(binding("new-epoch"), "utf8"), before);
    const unrelated = runtime({ toolAllowlistByAgent: { target: ["read"], another: ["web_search"] } });
    await unrelated.run({ ...input, nativeStateId: "new-epoch", runId: "unrelated" });
    const otherOnly = runtime({ toolAllowlistByAgent: { another: ["web_search"] } });
    await otherOnly.run({ ...input, runId: "legacy-continues" });
    assert.equal(JSON.parse(await readFile(binding("legacy"), "utf8")).toolPolicyFingerprint, undefined);
    await changed.run({ ...input, nativeStateId: "newer-epoch", runId: "reset" });
  } finally {
    await Promise.all(runtimes.map((instance) => instance.dispose()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
