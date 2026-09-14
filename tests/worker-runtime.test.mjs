import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import * as Spine from "@deepseek-ai/dsh-agent-spine-demo";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { BridgeWorker } from "../dist/bridge/index.js";
import { JsonRpcPeer } from "../dist/rpc.js";

const text = (value) => ({ type: "text-delta", index: 0, text: value });
const finish = (kind = "stop") => ({ type: "finish", reason: { kind } });
const tool = (name = "host_read", id = "call-1", args = { file: "hello" }) => ({
  type: "block-end", index: 1,
  block: { type: "tool-call", id, name, arguments: JSON.stringify(args) },
});
const callback = {
  name: "host_read", description: "Read through the host",
  parameters: {
    type: "object", properties: { file: { type: "string" } },
    required: ["file"], additionalProperties: false,
  },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness(t, generate = async function* () { yield text("Done"); yield finish(); }, options = {}) {
  const root = options.root ?? path.join(process.cwd(), `.worker-runtime-${randomUUID()}`);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(Spine, {
    agents: [], includeHarnessIdentity: false, includeRuntimeContext: false,
    persona: "", workspaceContext: false, skills: { enabled: false }, goals: false,
    toolBash: false, toolJobs: false, tools: { mode: "native" },
  }).await();
  await ctx.plugin(JsonlSessionPersistence, { root: path.join(root, "sessions"), compression: "none" }).await();
  let fibers;
  do {
    fibers = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]);
    await Promise.all(fibers.map((fiber) => fiber.await()));
  } while (fibers.some((fiber) => fiber.inertia));
  let calls = 0;
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      return {
        ...await super.resolveModel(provider, model, signal),
        reasoning: { efforts: [{ id: "high", name: "High" }, { id: "off", name: "Off" }] },
      };
    }
    stream(request) {
      requests.push(request);
      return generate(request, ++calls);
    }
  }
  ctx.llm.registerAdapter(["deepseek-official"], new Adapter());
  const toWorker = new PassThrough();
  const toHost = new PassThrough();
  const events = [];
  const errors = [];
  const stopped = Promise.withResolvers();
  let stops = 0;
  let shutdownSeen = false;
  const peer = new JsonRpcPeer(toHost, toWorker, {
    onRequest: options.onTool ?? (async () => { throw new Error("Unexpected host callback"); }),
    onNotification(method, event) {
      assert.equal(method, "event");
      events.push(event);
      options.onEvent?.(event);
    },
  });
  const worker = new BridgeWorker(ctx, toWorker, toHost, async () => {
    stops++;
    await ctx.fiber.dispose();
    stopped.resolve({ stops, shutdownSeen });
  }, (error) => errors.push(error));
  t.after(async () => {
    peer.close();
    toWorker.end();
    await worker.cleanup().catch(() => {});
    await ctx.fiber.dispose();
    if (!options.root) await rm(root, { recursive: true, force: true });
  });
  await worker.ready();
  await peer.drain();
  return {
    root, workspace, ctx, peer, worker, events, errors, requests, stopped,
    run: {
      sessionId: randomUUID(), resume: false, workspaceDir: workspace,
      systemPrompt: "Only host instructions: {{not_a_dsh_variable}}",
      prompt: "Hello", modelId: "deepseek-chat", tools: [],
    },
    async shutdown() {
      const response = await peer.request("shutdown", {});
      shutdownSeen = true;
      await stopped.promise;
      return response;
    },
    disconnect() { toWorker.end(); },
  };
}

test("streams a literal complete prompt and waits for committed output and durable session", async (t) => {
  const streamed = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const h = await harness(t, async function* (request) {
    assert.equal(request.system, "Only host instructions: {{not_a_dsh_variable}}");
    assert.deepEqual(request.tools ?? [], []);
    yield text("Hello");
    await release.promise;
    yield { type: "reasoning-delta", index: 1, text: "Reason" };
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 8 } };
    yield finish();
  }, { onEvent(event) { if (event.type === "text") streamed.resolve(); } });
  assert.deepEqual(h.events[0], { type: "ready", version: 1, dshVersion: "0.1.2-alpha.2" });
  let settled = false;
  const run = h.peer.request("run", h.run).finally(() => { settled = true; });
  await streamed.promise;
  await h.peer.drain();
  assert.equal(settled, false);
  assert.equal(h.events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Hello");
  release.resolve();
  const result = await run;
  assert.equal(result.text, "Hello");
  assert.equal(result.reasoning, "Reason");
  assert.deepEqual(result.usage, { input: 3, output: 2, cacheRead: 8, cacheWrite: 0 });
  assert.equal(result.stopReason, "stop");
  const persisted = await h.ctx.sessionPersistence.load(h.run.sessionId);
  assert.equal(persisted.events.at(-1).type, "turn/end");
  await assert.rejects(h.peer.request("run", h.run), /one run/);
  assert.deepEqual(await h.shutdown(), {});
  assert.equal((await h.stopped.promise).shutdownSeen, true);
});

test("registers only host callbacks and preserves host tool failures in the model transcript", async (t) => {
  const received = [];
  const h = await harness(t, async function* (request, step) {
    assert.deepEqual(request.tools.map((schema) => schema.name), ["host_read"]);
    if (step === 1) {
      yield text("Checking. ");
      yield tool();
      yield finish("tool-calls");
    } else {
      const result = request.messages.flatMap((message) => message.content).find((block) => block.type === "tool-result");
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, [{ type: "text", text: "Host denied this file" }]);
      yield text("Denied.");
      yield finish();
    }
  }, {
    onTool: async (method, params) => {
      received.push({ method, params });
      return { text: "Host denied this file", isError: true };
    },
  });
  const result = await h.peer.request("run", { ...h.run, tools: [callback] });
  assert.equal(result.text, "Checking. Denied.");
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(received, [{
    method: "tool", params: { callId: "call-1", name: "host_read", arguments: { file: "hello" } },
  }]);
  assert.deepEqual(h.ctx.tools.schemas(), []);
  assert.deepEqual(h.ctx.agents.list()[0].ctx.tools.schemas(h.ctx.agents.list()[0]).map((tool) => tool.name), ["host_read"]);
  await h.shutdown();
});

test("cancel notifies tool-cancel and waits for the host's actual settlement", async (t) => {
  const invoked = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const release = Promise.withResolvers();
  const h = await harness(t, async function* () {
    yield tool();
    yield finish("tool-calls");
  }, {
    onTool: async () => { invoked.resolve(); return release.promise; },
    onEvent(event) { if (event.type === "tool-cancel") cancelled.resolve(event); },
  });
  t.after(() => release.resolve({ text: "stopped", isError: true }));
  let settled = false;
  const run = h.peer.request("run", { ...h.run, tools: [callback] }).finally(() => { settled = true; });
  await invoked.promise;
  await h.peer.notify("cancel", {});
  assert.equal((await cancelled.promise).callId, "call-1");
  await tick();
  assert.equal(settled, false);
  release.resolve({ text: "stopped", isError: true });
  const result = await run;
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.toolCalls, 1);
  assert.equal(h.requests.length, 1);
  await h.shutdown();
});

test("run errors do not prevent shutdown response drain and root disposal", async (t) => {
  const h = await harness(t);
  const file = path.join(h.workspace, "file");
  await writeFile(file, "not a workspace directory");
  await assert.rejects(h.peer.request("run", { ...h.run, workspaceDir: file }), /not a directory/);
  await h.shutdown();
  assert.equal((await h.stopped.promise).shutdownSeen, true);
});

test("run awaits the post-turn flush and propagates a failed durability checkpoint", async (t) => {
  for (const fails of [false, true]) {
    await t.test(fails ? "failed flush" : "delayed flush", async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      t.after(() => release.resolve());
      const h = await harness(t);
      const off = h.ctx.on("session/flush", async (session) => {
        if (session.events.at(-1)?.type !== "turn/end") return;
        entered.resolve();
        await release.promise;
        off();
        if (fails) throw new Error("checkpoint failed");
      });
      let settled = false;
      const run = h.peer.request("run", h.run).finally(() => { settled = true; });
      await entered.promise;
      await tick();
      assert.equal(settled, false);
      release.resolve();
      if (fails) await assert.rejects(run, /checkpoint failed/);
      else assert.equal((await run).stopReason, "stop");
      await h.shutdown();
    });
  }
});

test("a teardown flush failure still drains its error response and disposes the root", async (t) => {
  const h = await harness(t);
  await h.peer.request("run", h.run);
  const off = h.ctx.on("session/flush", () => {
    off();
    throw new Error("teardown checkpoint failed");
  });
  await assert.rejects(h.peer.request("shutdown", {}), /cleanup failed/);
  await h.stopped.promise;
  await tick();
  assert.match(h.errors[0]?.message ?? "", /cleanup failed/);
  assert.equal(h.ctx.get("agents"), undefined);
});

test("invalid unknown input rejects before agent creation", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.peer.request("run", { ...h.run, sessionId: "..\\outside" }), /sessionId/);
  await assert.rejects(h.peer.request("shutdown", { unexpected: true }), /Unexpected/);
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.requests.length, 0);
  await h.shutdown();
});

test("malformed callback results and unapproved tool calls fail instead of fabricating success", async (t) => {
  for (const name of ["host_read", "native_shell"]) {
    await t.test(name, async (t) => {
      const h = await harness(t, async function* () {
        yield tool(name);
        yield finish("tool-calls");
      }, { onTool: async () => ({ text: "not a complete result" }) });
      await assert.rejects(h.peer.request("run", { ...h.run, tools: [callback] }), /isError|Unapproved/);
      await h.shutdown();
    });
  }
});

test("actual global tool registrations are rejected even with innocuous names", async (t) => {
  const h = await harness(t);
  h.ctx.tools.register({
    name: "innocuous_name", description: "Not approved", parameters: { type: "object" },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() { throw new Error("must not execute"); },
  });
  await assert.rejects(h.peer.request("run", h.run), /visible tool surface/);
  assert.equal(h.requests.length, 0);
  await h.shutdown();
});

test("disconnect cancels and disposes the owned agent and flushes its interrupted session", async (t) => {
  const started = Promise.withResolvers();
  const h = await harness(t, async function* ({ signal }) {
    yield text("Prefix");
    started.resolve();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  });
  const run = h.peer.request("run", h.run);
  const rejected = assert.rejects(run, /connection closed|closed|aborted/i);
  await started.promise;
  h.disconnect();
  h.peer.close();
  await rejected;
  await h.stopped.promise;
  assert.equal(h.ctx.get("agents"), undefined);
});

test("JSONL session resumes across root restart and rejects fresh-create or workspace aliases", async (t) => {
  const root = path.join(process.cwd(), `.worker-resume-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  let id;
  await t.test("create and persist", async (t) => {
    const h = await harness(t, undefined, { root });
    id = h.run.sessionId;
    await h.peer.request("run", { ...h.run, reasoningEffort: "high", maxTokens: 17 });
    assert.equal(h.requests[0].reasoningEffort, "high");
    assert.equal(h.requests[0].maxTokens, 17);
    await h.shutdown();
  });
  await t.test("fresh create rejects existing durable identity", async (t) => {
    const h = await harness(t, undefined, { root });
    await assert.rejects(h.peer.request("run", { ...h.run, sessionId: id }), /resume is required/);
    await h.shutdown();
  });
  await t.test("resume with wrong workspace rejects before driving", async (t) => {
    const h = await harness(t, undefined, { root });
    await assert.rejects(h.peer.request("run", { ...h.run, sessionId: id, resume: true, workspaceDir: root }), /different workspace/);
    assert.equal(h.requests.length, 0);
    await h.shutdown();
  });
  await t.test("resume restores history without replaying earlier stream events", async (t) => {
    const h = await harness(t, async function* (request) {
      assert.ok(request.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.text === "Done")));
      assert.equal(request.reasoningEffort, undefined);
      assert.equal(request.maxTokens, undefined);
      yield text("Resumed");
      yield finish();
    }, { root });
    const result = await h.peer.request("run", { ...h.run, sessionId: id, resume: true, prompt: "Continue" });
    assert.equal(result.text, "Resumed");
    assert.equal(result.sessionId, id);
    assert.equal(h.events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Resumed");
    await h.shutdown();
  });
});

test("cancellation before create persists an empty session that survives child restart", async (t) => {
  const root = path.join(process.cwd(), `.worker-early-cancel-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  let id;
  await t.test("cancelled create", async (t) => {
    const h = await harness(t, undefined, { root });
    id = h.run.sessionId;
    await h.peer.notify("cancel", {});
    const result = await h.peer.request("run", h.run);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.text, "");
    assert.equal(h.requests.length, 0);
    assert.ok((await h.ctx.sessionPersistence.list()).some((header) => header.id === id));
    await h.shutdown();
  });
  await t.test("resume cancelled identity", async (t) => {
    const h = await harness(t, undefined, { root });
    const result = await h.peer.request("run", { ...h.run, sessionId: id, resume: true });
    assert.equal(result.text, "Done");
    await h.shutdown();
  });
});
