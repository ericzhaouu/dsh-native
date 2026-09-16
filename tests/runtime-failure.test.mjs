import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDshConfig } from "../dist/config.js";
import { JsonRpcPeer } from "../dist/rpc.js";
import { createDshRuntime } from "../dist/runtime.js";

function childFixture({ ignoreKill = false, ready = true, trailingGarbage = false, onRun } = {}) {
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
      if (method === "run") {
        const result = onRun ? await onRun(params, peer) : {};
        return {
          text: "done", sessionId: params.sessionId, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          stopReason: "stop", toolCalls: 0, ...result,
        };
      }
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
  const root = join(fileURLToPath(new URL(".", import.meta.url)), `.runtime-failure-${randomUUID()}`);
  await mkdir(root);
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

const policy = {
  version: 1, executionTools: ["read"], skillAllowlist: [],
  maxClarificationTurns: 2, maxToolCalls: 1,
};
const readTool = {
  name: "read", description: "Read a fixture",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

function enablePreparation(input) {
  input.taskPreparation = { policy: structuredClone(policy), userText: "Read the sample fixture." };
  input.onPreparationDecision = () => {};
  input.tools = [readTool];
  return input;
}

function decisionFor(request, overrides = {}) {
  return {
    version: 1, revision: request.previous?.revision ?? 0,
    mode: "execute", task: request.previous ? "continue" : "new",
    goal: "Read the sample fixture.", deliverables: ["A fixture summary"],
    constraints: [], assumptions: [], unresolved: [], question: "",
    enhancedPrompt: "Read the sample fixture and summarize its contents.",
    evidence: { source: "current", quote: request.userText }, ...overrides,
  };
}

async function prepare(params, peer) {
  return { preparation: await peer.request("prepare", { decision: decisionFor(params.taskPreparation) }) };
}

function bindingPath(root, input) {
  return join(root, createHash("sha256").update(input.sessionId).digest("hex"), "binding.json");
}

test("preparation input validation happens before child startup", async (t) => {
  for (const [name, change, pattern] of [
    ["missing callback", (input) => { delete input.onPreparationDecision; }, /callback/],
    ["invalid callback", (input) => { input.onPreparationDecision = true; }, /callback/],
    ["unknown policy field", (input) => { input.taskPreparation.policy.secret = "not-permitted"; }, /preparation|policy|unknown/i],
    ["invalid budget", (input) => { input.taskPreparation.policy.maxToolCalls = -1; }, /preparation|policy|maxToolCalls/i],
    ["non-string user text", (input) => { input.taskPreparation.userText = {}; }, /preparation|userText/i],
    ["unknown option field", (input) => { input.taskPreparation.previous = {}; }, /preparation/i],
    ["control tool collision", (input) => { input.tools = [{ ...readTool, name: "dsh_prepare_task" }]; }, /reserved|collid/i],
  ]) {
    await t.test(name, async (t) => withMock(t, {}, async ({ runtime, input, children }) => {
      change(enablePreparation(input));
      await assert.rejects(runtime.run(input), pattern);
      assert.equal(children.length, 0);
    }));
  }
});

test("disabled runs omit preparation and reject the private prepare RPC", async (t) => {
  await withMock(t, { async onRun(params, peer) {
    assert.equal(Object.hasOwn(params, "taskPreparation"), false);
    await assert.rejects(peer.request("prepare", { decision: {} }), /Invalid|out-of-turn/);
    return {};
  } }, async ({ root, runtime, input }) => {
    const result = await runtime.run(input);
    assert.equal(Object.hasOwn(result, "preparation"), false);
    const binding = JSON.parse(await readFile(bindingPath(root, input), "utf8"));
    assert.equal(binding.status, "ready");
    assert.equal(Object.hasOwn(binding, "taskPreparation"), false);
  });
});

test("parent callback completes before the worker receives authorization", async (t) => {
  let callbackStarted;
  const started = new Promise((resolve) => { callbackStarted = resolve; });
  let callbackRelease;
  const released = new Promise((resolve) => { callbackRelease = resolve; });
  let callbackFinished = false;
  let calls = 0;
  await withMock(t, { async onRun(params, peer) {
    const pending = peer.request("prepare", { decision: decisionFor(params.taskPreparation) });
    await started;
    try {
      await assert.rejects(peer.request("tool", { callId: "too-early", name: "read", arguments: {} }), /not authorized/i);
      assert.equal(calls, 0);
      assert.equal(callbackFinished, false);
    } finally { callbackRelease(); }
    const preparation = await pending;
    assert.equal(callbackFinished, true);
    await peer.request("tool", { callId: "authorized", name: "read", arguments: {} });
    return { preparation, toolCalls: 1 };
  } }, async ({ runtime, input }) => {
    enablePreparation(input);
    input.onPreparationDecision = async (resolution) => {
      callbackStarted();
      await released;
      // Host callback mutation must not alter the runtime's authoritative decision.
      resolution.allowedTools.length = 0;
      resolution.state.sourceRunId = "forged-by-callback";
      callbackFinished = true;
    };
    input.executeTool = async () => { calls++; return { text: "sample", isError: false }; };
    const result = await runtime.run(input);
    assert.equal(calls, 1);
    assert.deepEqual(result.preparation.allowedTools, ["read"]);
    assert.equal(result.preparation.state.sourceRunId, input.runId);
  });
});

test("preparation budget reserves concurrent dispatches and denies tools outside the ceiling", async (t) => {
  let calls = 0;
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  let releaseDispatch;
  const released = new Promise((resolve) => { releaseDispatch = resolve; });
  await withMock(t, { async onRun(params, peer) {
    const { preparation } = await prepare(params, peer);
    await assert.rejects(peer.request("tool", { callId: "outside", name: "write", arguments: {} }), /not authorized/i);
    const first = peer.request("tool", { callId: "first", name: "read", arguments: {} });
    await started;
    try {
      await assert.rejects(peer.request("tool", { callId: "concurrent", name: "read", arguments: {} }), /budget/i);
      assert.equal(calls, 1);
    } finally { releaseDispatch(); }
    await first;
    await assert.rejects(peer.request("tool", { callId: "later", name: "read", arguments: {} }), /budget/i);
    await assert.rejects(peer.request("tool", { callId: "first", name: "read", arguments: {} }), /Duplicate/);
    return { preparation, toolCalls: 1 };
  } }, async ({ runtime, input }) => {
    enablePreparation(input);
    input.tools.push({ ...readTool, name: "write" });
    input.executeTool = async () => {
      calls++;
      dispatchStarted();
      await released;
      return { text: "sample", isError: false };
    };
    await runtime.run(input);
    assert.equal(calls, 1);
  });
});

test("a failed host dispatch still consumes the preparation budget", async (t) => {
  let calls = 0;
  await withMock(t, { async onRun(params, peer) {
    const { preparation } = await prepare(params, peer);
    await assert.rejects(peer.request("tool", { callId: "failed", name: "read", arguments: {} }), /host failed/);
    await assert.rejects(peer.request("tool", { callId: "retry", name: "read", arguments: {} }), /budget/);
    return { preparation, toolCalls: 1 };
  } }, async ({ runtime, input }) => {
    enablePreparation(input);
    input.executeTool = () => { calls++; throw new Error("host failed"); };
    await runtime.run(input);
    assert.equal(calls, 1);
  });
});

test("chat, clarify and draft preparation never authorize a host dispatch", async (t) => {
  for (const mode of ["chat", "clarify", "draft"]) {
    await t.test(mode, async (t) => withMock(t, { async onRun(params, peer) {
      const preparation = await peer.request("prepare", { decision: decisionFor(params.taskPreparation, {
        mode, ...(mode === "chat" ? { task: "none" } : {}),
        ...(mode === "clarify" ? { question: "Which fixture?", unresolved: ["The fixture name"] } : {}),
      }) });
      assert.deepEqual(preparation.allowedTools, []);
      await assert.rejects(peer.request("tool", { callId: "denied", name: "read", arguments: {} }), /not authorized/i);
      return { preparation };
    } }, async ({ runtime, input }) => {
      enablePreparation(input);
      const result = await runtime.run(input);
      assert.equal(result.preparation.decision.mode, mode);
      assert.equal(result.toolCalls, 0);
    }));
  }
});

test("an empty preparation ceiling has no implicit host tool authorization", async (t) => {
  await withMock(t, { async onRun(params, peer) {
    const { preparation } = await prepare(params, peer);
    assert.deepEqual(preparation.allowedTools, []);
    await assert.rejects(peer.request("tool", { callId: "no-default", name: "read", arguments: {} }), /not authorized/i);
    return { preparation };
  } }, async ({ runtime, input }) => {
    enablePreparation(input);
    input.taskPreparation.policy.executionTools = [];
    await runtime.run(input);
  });
});

test("invalid and repeated preparation decisions fatally block a submitted binding", async (t) => {
  for (const [name, raw, duplicate = false] of [
    ["stale revision", (request) => ({ decision: decisionFor(request, { revision: 1 }) })],
    ["forged quote", (request) => ({ decision: decisionFor(request, { evidence: { source: "current", quote: "Invented authority" } }) })],
    ["forged previous source", (request) => ({ decision: decisionFor(request, { evidence: { source: "previous", quote: request.userText } }) })],
    ["unknown decision field", (request) => ({ decision: { ...decisionFor(request), sourceRunId: "forged" } })],
    ["extra RPC parameter", (request) => ({ decision: decisionFor(request), resolution: {} })],
    ["missing decision", () => ({})],
    ["repeated prepare", (request) => ({ decision: decisionFor(request) }), true],
  ]) {
    await t.test(name, async (t) => {
      let callbacks = 0;
      await withMock(t, { async onRun(params, peer) {
        if (duplicate) await prepare(params, peer);
        return { preparation: await peer.request("prepare", raw(params.taskPreparation)) };
      } }, async ({ root, runtime, input, children }) => {
        enablePreparation(input);
        input.onPreparationDecision = () => { callbacks++; };
        await assert.rejects(runtime.run(input), /preparation|revision|evidence|quote|decision|source|unexpected/i);
        assert.equal(callbacks, duplicate ? 1 : 0);
        assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
        await assert.rejects(runtime.run({ ...input, runId: "second" }), /uncertain/);
        assert.equal(children.length, 1);
      });
    });
  }
});

test("throwing, revoked and cancelled parent preparation callbacks never open the tool gate", async (t) => {
  for (const mode of ["throw", "revoke", "cancel"]) {
    await t.test(mode, async (t) => {
      let calls = 0;
      let active = true;
      const controller = new AbortController();
      await withMock(t, { async onRun(params, peer) {
        const { preparation } = await prepare(params, peer);
        await peer.request("tool", { callId: "forbidden", name: "read", arguments: {} });
        return { preparation };
      } }, async ({ root, runtime, input, children }) => {
        enablePreparation(input);
        input.signal = controller.signal;
        input.assertActive = () => { if (!active) throw new Error("authority revoked"); };
        input.onPreparationDecision = async () => {
          if (mode === "throw") throw new Error("preparation callback refused");
          if (mode === "revoke") active = false;
          if (mode === "cancel") controller.abort(new Error("preparation callback cancelled"));
        };
        input.executeTool = async () => { calls++; return { text: "unexpected", isError: false }; };
        await assert.rejects(runtime.run(input), /callback refused|authority revoked|callback cancelled/);
        assert.equal(calls, 0);
        assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
        await assert.rejects(runtime.run({
          ...input, runId: "second", signal: new AbortController().signal, assertActive() {},
        }), /uncertain/);
        assert.equal(children.length, 1);
      });
    });
  }
});

test("only the exact parent-authoritative preparation result can make a binding ready", async (t) => {
  for (const [name, transform] of [
    ["missing resolution", () => ({})],
    ["different source", (preparation) => {
      preparation.state.sourceRunId = "forged-run";
      return { preparation };
    }],
    ["different allowed tools", (preparation) => {
      preparation.allowedTools = [];
      return { preparation };
    }],
    ["unknown resolution field", (preparation) => ({ preparation: { ...preparation, metadata: {} } })],
  ]) {
    await t.test(name, async (t) => withMock(t, { async onRun(params, peer) {
      return transform((await prepare(params, peer)).preparation);
    } }, async ({ root, runtime, input }) => {
      enablePreparation(input);
      await assert.rejects(runtime.run(input), /preparation|authoritative|resolution|unexpected/i);
      assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
    }));
  }
});

test("disabled runs reject unsolicited worker preparation results", async (t) => {
  await withMock(t, { async onRun() {
    const resolvedDecision = decisionFor({ userText: "Read the sample fixture." });
    const { task: _task, evidence: _evidence, ...brief } = resolvedDecision;
    return { preparation: {
      version: 1, decision: resolvedDecision, allowedTools: ["read"],
      state: {
        ...brief, revision: 1, sourceRunId: "first",
        requestText: "Read the sample fixture.", clarificationTurns: 0,
      },
    } };
  } }, async ({ root, runtime, input }) => {
    await assert.rejects(runtime.run(input), /preparation|resolution/i);
    assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
  });
});

test("aborting before preparation returns an aborted result but blocks session reuse", async (t) => {
  const controller = new AbortController();
  await withMock(t, { async onRun() {
    controller.abort();
    return { stopReason: "aborted" };
  } }, async ({ root, runtime, input, children }) => {
    enablePreparation(input);
    input.signal = controller.signal;
    const result = await runtime.run(input);
    assert.equal(result.stopReason, "aborted");
    assert.equal(Object.hasOwn(result, "preparation"), false);
    const binding = JSON.parse(await readFile(bindingPath(root, input), "utf8"));
    assert.equal(binding.status, "blocked");
    assert.equal(Object.hasOwn(binding, "taskPreparation"), false);
    await assert.rejects(runtime.run({ ...input, runId: "second", signal: new AbortController().signal }), /uncertain/);
    assert.equal(children.length, 1);
  });
});

test("successful worker output without a preparation decision is not accepted", async (t) => {
  await withMock(t, {}, async ({ root, runtime, input }) => {
    enablePreparation(input);
    await assert.rejects(runtime.run(input), /without.*preparation/);
    assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
  });
});

test("a worker cannot settle while its preparation callback is still pending", async (t) => {
  let callbackStarted;
  const started = new Promise((resolve) => { callbackStarted = resolve; });
  let releaseCallback;
  const released = new Promise((resolve) => { releaseCallback = resolve; });
  await withMock(t, { async onRun(params, peer) {
    void peer.request("prepare", { decision: decisionFor(params.taskPreparation) }).catch(() => {});
    await started;
    return { stopReason: "aborted" };
  } }, async ({ root, runtime, input }) => {
    enablePreparation(input);
    input.onPreparationDecision = async () => { callbackStarted(); await released; };
    let settled = false;
    const pending = runtime.run(input).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, /preparation callback completed/);
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(settled, false, "Run settlement must wait for the pending host callback");
      let disposed = false;
      const disposal = runtime.dispose().then(() => { disposed = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(disposed, false);
      releaseCallback();
      await rejected;
      await disposal;
      assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
    } finally { releaseCallback(); }
  });
});

test("an unconfirmed preparation callback retains the ownership lock instead of permitting reuse", async (t) => {
  let callbackStarted;
  const started = new Promise((resolve) => { callbackStarted = resolve; });
  let releaseCallback;
  const released = new Promise((resolve) => { releaseCallback = resolve; });
  await withMock(t, { async onRun(params, peer) {
    void peer.request("prepare", { decision: decisionFor(params.taskPreparation) }).catch(() => {});
    await started;
    return { stopReason: "aborted" };
  } }, async ({ root, runtime, input }) => {
    enablePreparation(input);
    input.onPreparationDecision = async () => { callbackStarted(); await released; };
    try {
      await assert.rejects(runtime.run(input), /callback did not settle.*ownership lock/);
      const directory = join(root, createHash("sha256").update(input.sessionId).digest("hex"));
      assert.ok(await readFile(join(directory, "owner.lock"), "utf8"));
      assert.equal(JSON.parse(await readFile(bindingPath(root, input), "utf8")).status, "blocked");
    } finally { releaseCallback(); }
  });
});

test("preparation is not persisted ready when native shutdown fails", async (t) => {
  await withMock(t, { onRun: prepare, trailingGarbage: true }, async ({ root, runtime, input }) => {
    enablePreparation(input);
    await assert.rejects(runtime.run(input), /Invalid/);
    const binding = JSON.parse(await readFile(bindingPath(root, input), "utf8"));
    assert.equal(binding.status, "blocked");
    assert.equal(Object.hasOwn(binding, "taskPreparation"), false);
  });
});

test("canonical policy and authoritative prior state persist across children with a newly closed gate", async (t) => {
  const requests = [];
  let calls = 0;
  await withMock(t, { async onRun(params, peer) {
    requests.push(params.taskPreparation);
    await assert.rejects(peer.request("tool", { callId: "before-prepare", name: "read", arguments: {} }), /not authorized/i);
    return prepare(params, peer);
  } }, async ({ root, runtime, input, children }) => {
    enablePreparation(input);
    input.taskPreparation.policy.executionTools.push("write");
    input.tools.push({ ...readTool, name: "write" });
    input.executeTool = async () => { calls++; return { text: "unexpected", isError: false }; };
    const first = await runtime.run(input);
    assert.equal(Object.hasOwn(requests[0], "previous"), false);
    assert.equal(requests[0].userText, input.taskPreparation.userText);
    const original = JSON.parse(await readFile(bindingPath(root, input), "utf8"));
    assert.deepEqual(Object.keys(original.taskPreparation).sort(), ["policyFingerprint", "state", "version"]);
    assert.match(original.taskPreparation.policyFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(original.taskPreparation.state, first.preparation.state);
    assert.equal(JSON.stringify(original).includes(input.apiKey), false);
    const second = await runtime.run({
      ...input, runId: "second", taskPreparation: {
        userText: "Continue reading the sample fixture.",
        policy: {
          maxToolCalls: 1, maxClarificationTurns: 2, skillAllowlist: [],
          executionTools: ["write", "read"], version: 1,
        },
      },
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(requests[1].previous, first.preparation.state);
    assert.equal(second.preparation.state.revision, 2);
    assert.equal(second.preparation.state.sourceRunId, "second");
    const current = JSON.parse(await readFile(bindingPath(root, input), "utf8"));
    assert.equal(current.taskPreparation.policyFingerprint, original.taskPreparation.policyFingerprint);
    assert.deepEqual(current.taskPreparation.state, second.preparation.state);
    assert.equal(current.lastRunId, "second");
    assert.equal(calls, 0);
    await assert.rejects(runtime.run(input), /already submitted/);
    assert.equal(children.length, 2);
  });
});

test("enabling, disabling or changing preparation on a ready binding requires /new", async (t) => {
  for (const mode of ["enable", "disable", "policy"]) {
    await t.test(mode, async (t) => withMock(t, { async onRun(params, peer) {
      return params.taskPreparation ? prepare(params, peer) : {};
    } }, async ({ runtime, input, children }) => {
      if (mode !== "enable") enablePreparation(input);
      await runtime.run(input);
      if (mode === "enable") enablePreparation(input);
      if (mode === "disable") delete input.taskPreparation;
      if (mode === "policy") input.taskPreparation.policy.maxToolCalls++;
      await assert.rejects(runtime.run({ ...input, runId: "second" }), /\/new/);
      assert.equal(children.length, 1);
    }));
  }
});

test("corrupt preparation bindings fail closed before spawning another child", async (t) => {
  for (const [name, change] of [
    ["invalid wrapper", (state) => { state.taskPreparation = null; }],
    ["unknown wrapper version", (state) => { state.taskPreparation.version = 2; }],
    ["extra metadata", (state) => { state.taskPreparation.metadata = { secret: true }; }],
    ["malformed fingerprint", (state) => { state.taskPreparation.policyFingerprint = "bad"; }],
    ["changed fingerprint", (state) => { state.taskPreparation.policyFingerprint = "0".repeat(64); }],
    ["invalid state mode", (state) => { state.taskPreparation.state.mode = "bypass"; }],
    ["extra state field", (state) => { state.taskPreparation.state.allowedTools = ["shell"]; }],
    ["stale source run", (state) => { state.taskPreparation.state.sourceRunId = "older"; }],
    ["stale revision", (state) => { state.taskPreparation.state.revision++; }],
    ["impossible clarification count", (state) => { state.taskPreparation.state.clarificationTurns = 3; }],
    ["missing enabled state", (state) => { delete state.taskPreparation; }],
    ["consumed run mismatch", (state) => { state.consumedRunIds = ["other"]; }],
  ]) {
    await t.test(name, async (t) => withMock(t, { onRun: prepare }, async ({ root, runtime, input, children }) => {
      enablePreparation(input);
      await runtime.run(input);
      const path = bindingPath(root, input);
      const state = JSON.parse(await readFile(path, "utf8"));
      change(state);
      await writeFile(path, JSON.stringify(state));
      await assert.rejects(runtime.run({ ...input, runId: "second" }), /\/new/);
      assert.equal(children.length, 1);
    }));
  }
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
