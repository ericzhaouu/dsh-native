import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { parseDshConfig } from "../dist/config.js";
import { JsonRpcPeer } from "../dist/rpc.js";
import { createDshRuntime } from "../dist/runtime.js";

function childFixture({ ignoreKill = false, ready = true, trailingGarbage = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 123456, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const kills = [];
  const exit = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdout.end();
    child.emit("close", 0);
  };
  child.kill = (signal = "SIGTERM") => { kills.push(signal); if (!ignoreKill) exit(); return true; };
  const peer = new JsonRpcPeer(child.stdin, child.stdout, {
    onRequest: async (method, params) => {
      if (method === "run") return {
        text: "done", sessionId: params.sessionId, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop", toolCalls: 0,
      };
      if (method === "shutdown") {
        setImmediate(() => { if (trailingGarbage) child.stdout.write("garbage\n"); exit(); });
        return {};
      }
      throw new Error("Unexpected method");
    },
  });
  if (ready) setImmediate(() => peer.notify("event", { type: "ready", version: 1, dshVersion: "0.1.2-alpha.2" }));
  return {
    child, kills,
    close() { peer.close(); exit(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); },
  };
}

async function withMock(t, options, run) {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-failure-"));
  const children = [];
  const spawn = t.mock.method(childProcess, "spawn", () => {
    const fixture = childFixture(options);
    children.push(fixture);
    return fixture.child;
  });
  syncBuiltinESMExports();
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root, startupTimeoutMs: 100, shutdownTimeoutMs: 100,
  }));
  const input = {
    sessionId: "failure-session", runId: "first", workspaceDir: root,
    prompt: "hello", systemPrompt: "test", modelId: "deepseek-v4-pro",
    apiKey: "test-key", baseUrl: "https://api.deepseek.com", contextWindow: 1000000,
    thinking: "disabled", tools: [], signal: new AbortController().signal,
    assertActive() {}, onEvent() {}, async executeTool() { throw new Error("No tools"); },
  };
  try { await run({ root, runtime, input, children }); }
  finally {
    await runtime.dispose();
    for (const child of children) child.close();
    spawn.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { force: true, recursive: true });
  }
}

test("all consumed attempt IDs remain replay-protected", async (t) => {
  await withMock(t, {}, async ({ runtime, input, children }) => {
    await runtime.run(input);
    await runtime.run({ ...input, runId: "second" });
    await assert.rejects(runtime.run(input), /already submitted/);
    assert.equal(children.length, 2);
  });
});

test("malformed shutdown output blocks native session reuse", async (t) => {
  await withMock(t, { trailingGarbage: true }, async ({ runtime, input }) => {
    await assert.rejects(runtime.run(input), /Invalid/);
    await assert.rejects(runtime.run({ ...input, runId: "second" }), /uncertain/);
  });
});

test("unconfirmed termination retains ownership even when startup never finished", async (t) => {
  await withMock(t, { ready: false, ignoreKill: true }, async ({ root, runtime, input, children }) => {
    await assert.rejects(runtime.run(input), /retaining.*lock/);
    assert.deepEqual(children[0].kills, ["SIGTERM", "SIGKILL"]);
    const key = createHash("sha256").update(input.sessionId).digest("hex");
    assert.ok(await readFile(join(root, key, "owner.lock"), "utf8"));
    await assert.rejects(runtime.run({ ...input, runId: "second" }), /already has an owner/);
    assert.equal(children.length, 1);
  });
});
