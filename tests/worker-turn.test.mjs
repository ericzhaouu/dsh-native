import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import * as Spine from "@deepseek-ai/dsh-agent-spine-demo";
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage, createUserMessage, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { TurnTracker } from "../src/bridge/turn.ts";

let nextId = 0;
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const finish = (kind = "stop") => ({ type: "finish", reason: { kind } });
const text = (value, index = 0) => ({ type: "text-delta", index, text: value });
const reasoning = (value, index = 1) => ({ type: "reasoning-delta", index, text: value });
const usage = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  type: "usage", usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
});
const failure = (kind = "error") => ({
  type: "finish", reason: { kind, failure: { message: "provider failed", code: "TEST" } },
});
const prompt = () => createUserMessage({ content: [{ type: "text", text: "Hello" }], source: { kind: "user" } });
const assistant = (content) => createAssistantMessage({ content, source: { provider: "test", model: "test" } });
const channel = (events, type) => events.filter((event) => event.type === type).map((event) => event.text).join("");

async function harness(t, generate = async function* () { yield text("Done"); yield finish(); }, setup, trackerOptions) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Spine, {
    agents: [], includeHarnessIdentity: false, includeRuntimeContext: false,
    persona: "", workspaceContext: false, skills: { enabled: false }, goals: false,
    toolBash: false, toolJobs: false, tools: { mode: "native" },
  }).await();
  let fibers;
  do {
    fibers = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]);
    await Promise.all(fibers.map((fiber) => fiber.await()));
  } while (fibers.some((fiber) => fiber.inertia));
  let calls = 0;
  class Adapter extends LlmAdapter {
    stream(options) { return generate(options, ++calls); }
  }
  ctx.llm.registerAdapter(["test"], new Adapter());
  const events = [];
  let tracker;
  const handle = await ctx.agents.create({
    sessionId: SessionId(`worker-turn-${++nextId}`),
    agentOptions: { provider: "test", model: "test" },
    setup(agentCtx) {
      tracker = new TurnTracker(agentCtx, (event) => events.push(event), trackerOptions);
      setup?.(agentCtx);
    },
  });
  const { agent } = handle;
  return {
    ctx, agent, tracker, events, handle,
    async settle(cancelled = false, toolCalls = 0) {
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      return tracker.result(agent.id, cancelled, toolCalls);
    },
  };
}

function manual(h) {
  const { session } = h.agent;
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  const sources = [];
  return {
    chunk(chunk) {
      sources.push(session.append("assistant/chunk", { turn: 1, step: 1, chunk }).seq);
    },
    commit(content, extra = {}, sourceEventSeqs = sources) {
      return session.append("assistant/message", {
        turn: 1, step: 1, message: assistant(content), ...extra,
      }, { surfaceOp: "append", sourceEventSeqs });
    },
    end(reason = { kind: "completed" }) {
      session.append("step/end", { turn: 1, step: 1 });
      session.append("turn/end", { turn: 1, reason });
    },
  };
}

test("attaches in public setup before synchronous running/turn-start, streams before idle", async (t) => {
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  const h = await harness(t, async function* () {
    yield text("Hel");
    started.resolve();
    await release.promise;
    yield text("lo");
    yield reasoning("Think");
    yield usage(7, 3, 11, 2);
    yield finish();
  });
  t.after(() => release.resolve());
  h.agent.followup(prompt());
  assert.deepEqual(h.events, [{ type: "status", status: "running" }]);
  assert.ok(h.agent.session.events.some((event) => event.type === "turn/start"));
  await started.promise;
  assert.equal(channel(h.events, "text"), "Hel");
  assert.throws(() => h.tracker.result(h.agent.id, false, 0), /whenIdle/);
  release.resolve();
  const result = await h.settle();
    assert.deepEqual(result, {
      text: "Hello", reasoning: "Think",
      usage: { input: 7, output: 3, cacheRead: 11, cacheWrite: 2 },
      contextUsage: { state: "available", promptTokens: 20, totalTokens: 23 },
      lastCallUsage: { input: 7, output: 3, cacheRead: 11, cacheWrite: 2 },
      stopReason: "stop", sessionId: h.agent.id, toolCalls: 0,
    });
  assert.equal(result.text, channel(h.events, "text"));
  assert.equal(result.reasoning, channel(h.events, "reasoning"));
  assert.equal(h.events.filter((event) => event.type === "usage").length, 1);
  assert.deepEqual(h.events.at(-1), { type: "status", status: "idle" });
});

test("concatenates tool-loop responses and emits only the last usage snapshot per completed response", async (t) => {
  const h = await harness(t, async function* (_options, call) {
    if (call === 1) {
      yield text("Checking. ");
      yield reasoning("First. ");
      yield {
        type: "block-end", index: 2,
        block: { type: "tool-call", id: "call-1", name: "check", arguments: "{}" },
      };
      yield usage(100, 100, 100);
      yield usage(7, 3, 11, 2);
      yield finish("tool-calls");
    } else {
      yield text("Done.");
      yield reasoning("Second.");
      yield usage(2, 5, 13, 1);
      yield finish();
    }
  }, (ctx) => {
    ctx.tools.register({
      name: "check", description: "In-memory test", parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      async execute() { return "checked"; },
    });
  });
  h.agent.followup(prompt());
  const result = await h.settle(false, 1);
  assert.equal(result.text, "Checking. Done.");
  assert.equal(result.reasoning, "First. Second.");
  assert.equal(result.text, channel(h.events, "text"));
  assert.equal(result.reasoning, channel(h.events, "reasoning"));
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.usage, { input: 9, output: 8, cacheRead: 24, cacheWrite: 3 });
  assert.deepEqual(h.events.filter((event) => event.type === "usage").map((event) => event.usage), [
    { input: 7, output: 3, cacheRead: 11, cacheWrite: 2 },
    { input: 2, output: 5, cacheRead: 13, cacheWrite: 1 },
  ]);
  assert.deepEqual(result.contextUsage, { state: "available", promptTokens: 16, totalTokens: 21 });
  assert.deepEqual(result.lastCallUsage, { input: 2, output: 5, cacheRead: 13, cacheWrite: 1 });
  assert.deepEqual(h.tracker.result(h.agent.id, false, 1), result);
  result.usage.input = 999;
  assert.equal(h.tracker.result(h.agent.id, false, 1).usage.input, 9);
});

test("block-end and committed message do not duplicate deltas; final-only suffix is delivered once", async (t) => {
  const h = await harness(t, async function* () {
    yield text("Hello");
    yield { type: "block-end", index: 0, block: { type: "text", text: "Hello world" } };
    yield text("ignored straggler");
    yield { type: "block-end", index: 0, block: { type: "text", text: "ignored re-close" } };
    yield finish();
  });
  h.agent.followup(prompt());
  const result = await h.settle();
  assert.equal(result.text, "Hello world");
  assert.deepEqual(h.events.filter((event) => event.type === "text").map((event) => event.text), ["Hello", " world"]);
  assert.deepEqual(result.usage, zero);
  assert.deepEqual(result.contextUsage, { state: "unavailable" });
  assert.equal(Object.hasOwn(result, "lastCallUsage"), false);
});

test("actual max-tokens turn ending is length", async (t) => {
  const h = await harness(t, async function* () { yield text("truncated"); yield finish("max-tokens"); });
  h.agent.followup(prompt());
  const result = await h.settle();
  assert.equal(result.stopReason, "length");
  assert.equal(h.agent.session.events.findLast((event) => event.type === "turn/end").data.reason.kind, "max-tokens");
});

test("complete-only blocks precede later deltas without reordering or duplicated final output", async (t) => {
  const h = await harness(t, async function* () {
    yield { type: "block-end", index: 0, block: { type: "text", text: "First. " } };
    yield text("Second.", 2);
    yield { type: "block-end", index: 1, block: { type: "reasoning", text: "Thought" } };
    yield finish();
  });
  h.agent.followup(prompt());
  const result = await h.settle();
  assert.equal(result.text, "First. Second.");
  assert.equal(result.reasoning, "Thought");
  assert.equal(result.text, channel(h.events, "text"));
  assert.equal(result.reasoning, channel(h.events, "reasoning"));
});

test("empty and whitespace-only final responses are not successful output", async (t) => {
  for (const value of ["", "   "]) {
    const h = await harness(t, async function* () { yield text(value); yield finish(); });
    h.agent.followup(prompt());
    await assert.rejects(h.settle(), /no committed final assistant output/);
  }
});

test("missing finish is rejected even though installed BlockAssembler defaults it to stop", async (t) => {
  const h = await harness(t, async function* () { yield text("not complete"); });
  h.agent.followup(prompt());
  await assert.rejects(h.settle(), /without a terminal finish/);
  assert.equal(h.agent.session.events.findLast((event) => event.type === "turn/end").data.reason.kind, "completed");
});

test("driver-contained terminal errors cannot be masked by idle or caller cancellation", async (t) => {
  for (const kind of ["error", "aborted"]) {
    const h = await harness(t, async function* () { yield failure(kind); });
    h.agent.followup(prompt());
    await h.agent.whenIdle();
    assert.equal(h.agent.status, "idle");
    await assert.rejects(h.settle(), /provider failed/);
    await assert.rejects(h.settle(true), /provider failed/);
  }
});

test("invisible failed attempts may retry with reused block indexes and excluded failed usage", async (t) => {
  const h = await harness(t, async function* (_options, call) {
    if (call === 1) {
      yield usage(99, 99, 99);
      yield failure();
    } else {
      yield text("Recovered");
      yield usage(2, 3, 4);
      yield finish();
    }
  }, (ctx) => ctx.on("agent/request-error", async () => ({ kind: "retry" })));
  h.agent.followup(prompt());
  const result = await h.settle();
  assert.equal(result.text, "Recovered");
  assert.deepEqual(result.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 0 });
  assert.equal(h.events.filter((event) => event.type === "usage").length, 1);
});

test("retry cannot silently succeed after abandoning emitted text or reasoning", async (t) => {
  for (const delta of [text, reasoning]) {
    const h = await harness(t, async function* (_options, call) {
      if (call === 1) { yield delta("abandoned"); yield failure(); }
      else { yield text("replacement"); yield finish(); }
    }, (ctx) => ctx.on("agent/request-error", async () => ({ kind: "retry" })));
    h.agent.followup(prompt());
    await assert.rejects(h.settle(), /abandoned streamed output/);
    assert.equal(h.agent.session.events.filter((event) => event.type === "assistant/message").length, 1);
  }
});

test("cancellation during request-error cannot conceal an unrecovered provider failure", async (t) => {
  const recovering = Promise.withResolvers();
  const h = await harness(t, async function* () { yield failure(); }, (ctx) => {
    ctx.on("agent/request-error", async ({ signal }) => {
      recovering.resolve();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      return { kind: "retry" };
    });
  });
  h.agent.followup(prompt());
  await recovering.promise;
  h.agent.cancel({ kind: "user" });
  await assert.rejects(h.settle(true), /provider failed/);
  assert.equal(h.agent.session.events.findLast((event) => event.type === "turn/end").data.reason.kind, "aborted");
});

test("cancelling an unfinished retry does not clear the earlier provider failure", async (t) => {
  const retrying = Promise.withResolvers();
  const h = await harness(t, async function* ({ signal }, call) {
    if (call === 1) { yield failure(); return; }
    yield text("retry prefix");
    retrying.resolve();
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    signal.throwIfAborted();
  }, (ctx) => ctx.on("agent/request-error", async () => ({ kind: "retry" })));
  h.agent.followup(prompt());
  await retrying.promise;
  h.agent.cancel({ kind: "user" });
  await assert.rejects(h.settle(true), /provider failed/);
});

test("cancels owned agent, drains interrupted prefix, then flushes before reading aborted result", async (t) => {
  const delivered = Promise.withResolvers();
  const h = await harness(t, async function* ({ signal }) {
    yield text("partial");
    yield reasoning("thinking");
    delivered.resolve();
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    signal.throwIfAborted();
  });
  let flushed = false;
  h.ctx.on("session/flush", async (session) => {
    if (session !== h.agent.session) return;
    assert.equal(h.agent.status, "idle");
    assert.equal(session.events.findLast((event) => event.type === "turn/end").data.reason.kind, "aborted");
    assert.equal(session.events.findLast((event) => event.type === "assistant/message").data.interrupted, true);
    await Promise.resolve();
    flushed = true;
  });
  h.agent.followup(prompt());
  await delivered.promise;
  h.agent.cancel({ kind: "user" });
  const result = await h.settle(true);
  assert.equal(flushed, true);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.text, channel(h.events, "text"));
  assert.equal(result.reasoning, channel(h.events, "reasoning"));
  assert.deepEqual(result.usage, zero);
  assert.equal(h.events.filter((event) => event.type === "usage").length, 0);
  assert.equal(h.tracker.result(h.agent.id, false, 0).stopReason, "aborted");
});

test("pre-step cancellation has no invented output and no-stream cancellation can be empty", async (t) => {
  const h = await harness(t);
  h.agent.followup(prompt());
  h.agent.cancel({ kind: "user" });
  assert.deepEqual(await h.settle(true), {
    text: "", usage: zero, contextUsage: { state: "unavailable" },
    stopReason: "aborted", sessionId: h.agent.id, toolCalls: 0,
  });
  const idle = await harness(t);
  assert.equal((await idle.settle(true)).stopReason, "aborted");
  await assert.rejects(idle.settle(), /no live turn completion/);
});

test("blocked and crash-interrupted turns, absent end, and uncommitted streams are rejected", async (t) => {
  const blocked = await harness(t, undefined, (ctx) => ctx.on("agent/pre-step", async () => ({ kind: "reject" })));
  blocked.agent.followup(prompt());
  await assert.rejects(blocked.settle(), /did not complete: blocked/);
  for (const kind of ["interrupted", "completed", undefined]) {
    const h = await harness(t);
    const m = manual(h);
    m.chunk(text("uncommitted"));
    m.chunk(finish());
    if (kind) m.end({ kind });
    await assert.rejects(h.settle(), /did not complete|no completed, committed|no committed turn\/end/);
  }
});

test("a previous successful response does not cover an abandoned last tool-loop step", async (t) => {
  const h = await harness(t);
  const m = manual(h);
  m.chunk(text("first"));
  m.chunk(finish());
  m.commit([{ type: "text", text: "first" }]);
  h.agent.session.append("step/end", { turn: 1, step: 1 });
  h.agent.session.append("step/start", { turn: 1, step: 2 });
  h.agent.session.append("assistant/chunk", { turn: 1, step: 2, chunk: text("lost") });
  h.agent.session.append("step/end", { turn: 1, step: 2 });
  h.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  await assert.rejects(h.settle(), /no completed, committed assistant output/);
});

test("final message provenance, text rewrites, and agent errors without turn markers are checked", async (t) => {
  for (const change of ["sources", "rewrite"]) {
    const h = await harness(t);
    const m = manual(h);
    m.chunk(text("live"));
    m.chunk(finish());
    m.commit([{ type: "text", text: change === "rewrite" ? "changed" : "live" }], {},
      change === "sources" ? [] : undefined);
    m.end();
    await assert.rejects(h.settle(), /different stream attempt|differs from emitted deltas/);
  }
  const h = await harness(t);
  const error = new Error("terminal append failure");
  emitAgentEvent(h.ctx, h.agent, "agent/error", { turn: 0, step: 0, error });
  await assert.rejects(h.settle(true), (thrown) => thrown === error);
});

test("durable error after committed output and interrupted output without abort cannot succeed", async (t) => {
  for (const interrupted of [false, true]) {
    const h = await harness(t);
    const m = manual(h);
    m.chunk(text("partial"));
    m.chunk(finish());
    m.commit([{ type: "text", text: "partial" }], interrupted ? { interrupted: true } : {});
    m.end(interrupted ? { kind: "completed" } : { kind: "error", error: { code: "TEST", message: "turn failed" } });
    await assert.rejects(h.settle(), /turn failed|no completed, committed/);
  }
});

test("flush rejects only after every listener settles; caller must propagate instead of returning result", async (t) => {
  const h = await harness(t);
  const order = [];
  h.ctx.on("session/flush", () => { order.push("failed"); throw new Error("durability failed"); });
  h.ctx.on("session/flush", async () => { await Promise.resolve(); order.push("drained"); });
  h.agent.followup(prompt());
  await assert.rejects(h.settle(), /durability failed/);
  assert.deepEqual(order, ["failed", "drained"]);
});

test("seeded history is not replayed and scoped events from another agent are ignored", async (t) => {
  const h = await harness(t);
  h.agent.followup(prompt());
  await h.settle();
  const seed = h.agent.session.events;
  const events = [];
  let tracker;
  const resumed = await h.ctx.agents.create({
    sessionId: SessionId(`worker-turn-seeded-${++nextId}`), seed,
    agentOptions: { provider: "test", model: "test" },
    setup(ctx) { tracker = new TurnTracker(ctx, (event) => events.push(event)); },
  });
  assert.deepEqual(events, []);
  assert.throws(() => tracker.result(resumed.agent.id, false, 0), /no live turn completion/);
  h.tracker.dispose();
  h.agent.followup(prompt());
  await h.agent.whenIdle();
  emitAgentEvent(h.ctx, h.agent, "agent/error", { turn: 1, step: 1, error: new Error("other agent") });
  assert.deepEqual(events, []);
  resumed.agent.followup(prompt());
  await resumed.agent.whenIdle();
  await h.ctx.sessions.flush(resumed.agent.session);
  assert.equal(tracker.result(resumed.agent.id, false, 0).text, "Done");
  assert.equal(events.filter((event) => event.type === "usage").length, 1);
  assert.equal(resumed.agent.session.events.findLast((event) => event.type === "turn/end").data.turn, 2);
});

test("requires scoped idle context, validates identity, detaches idempotently, and preserves emit errors", async (t) => {
  const h = await harness(t);
  assert.throws(() => new TurnTracker(h.ctx, () => {}), /agent-scoped/);
  assert.throws(() => h.tracker.result("wrong", true, 0), /identity/);
  assert.throws(() => h.tracker.result(h.agent.id, true, -1), /tool call count/);
  h.tracker.dispose();
  h.tracker.dispose();
  const thrown = new Error("bridge delivery failed");
  const tracker = new TurnTracker(h.agent.ctx, () => { throw thrown; });
  h.agent.followup(prompt());
  assert.throws(() => new TurnTracker(h.agent.ctx, () => {}), /before followup/);
  await h.agent.whenIdle();
  await h.ctx.sessions.flush(h.agent.session);
  assert.throws(() => tracker.result(h.agent.id, false, 0), (error) => error === thrown);
  assert.deepEqual(h.events, []);
});

test("internal steps hide every text/reasoning projection but retain canonical history and usage", async (t) => {
  const classified = [];
  const h = await harness(t, async function* (_options, call) {
    if (call === 1) {
      yield text("internal ");
      yield { type: "block-end", index: 0, block: { type: "text", text: "internal JSON" } };
      yield reasoning("private reasoning");
      yield {
        type: "block-end", index: 2,
        block: { type: "tool-call", id: "prepare", name: "control", arguments: "{}" },
      };
      yield usage(7, 4, 3, 2);
      yield finish("tool-calls");
    } else {
      yield text("Visible answer");
      yield reasoning("Visible reasoning");
      yield usage(2, 3, 4, 1);
      yield finish();
    }
  }, (ctx) => ctx.tools.register({
    name: "control", description: "Internal", parameters: { type: "object" },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() { return "internal result"; },
  }), { isInternalStep(turn, step) { classified.push([turn, step]); return step === 1; } });
  h.agent.followup(prompt());
  const result = await h.settle();
  assert.equal(result.text, "Visible answer");
  assert.equal(result.reasoning, "Visible reasoning");
  assert.equal(channel(h.events, "text"), result.text);
  assert.equal(channel(h.events, "reasoning"), result.reasoning);
  assert.deepEqual(result.usage, { input: 9, output: 7, cacheRead: 7, cacheWrite: 3 });
  assert.deepEqual(classified, [[1, 1], [1, 2]]);
  const messages = h.agent.session.events.filter((event) => event.type === "assistant/message");
  assert.ok(messages[0].data.message.content.some((block) => block.text === "internal JSON"));
  assert.ok(messages[0].data.message.content.some((block) => block.text === "private reasoning"));
});

test("internal-only output is never a visible final response, including max-tokens", async (t) => {
  for (const kind of ["stop", "max-tokens"]) {
    const h = await harness(t, async function* () { yield text("internal"); yield finish(kind); },
      undefined, { isInternalStep: () => true });
    h.agent.followup(prompt());
    await assert.rejects(h.settle(), /no committed final assistant output/);
    assert.equal(channel(h.events, "text"), "");
  }
});

test("hiding a step never bypasses stream provenance, canonical blocks, finish, or retry validation", async (t) => {
  for (const fault of ["sources", "rewrite", "block", "finish", "retry"]) {
    const h = await harness(t, undefined, undefined, { isInternalStep: () => true });
    const m = manual(h);
    m.chunk(text("raw"));
    if (fault === "block") m.chunk({ type: "block-end", index: 0, block: { type: "text", text: "changed" } });
    if (fault !== "finish") m.chunk(fault === "retry" ? failure() : finish());
    m.commit([{ type: "text", text: fault === "rewrite" ? "changed" : "raw" }], {},
      fault === "sources" ? [] : undefined);
    m.end();
    assert.throws(() => h.tracker.assertHealthy(), /different stream attempt|differs|terminal finish|abandoned streamed output/);
    await assert.rejects(h.settle(), /different stream attempt|differs|terminal finish|abandoned streamed output/);
    assert.equal(channel(h.events, "text"), "");
    assert.equal(channel(h.events, "reasoning"), "");
  }
});

test("internal classification is frozen at step/start and an interrupted internal prefix stays hidden", async (t) => {
  let internal = true;
  const h = await harness(t, undefined, undefined, { isInternalStep: () => internal });
  const m = manual(h);
  internal = false;
  m.chunk(text("internal partial"));
  m.chunk(reasoning("internal thinking"));
  m.commit([{ type: "text", text: "internal partial" }], { interrupted: true });
  m.end({ kind: "aborted", reason: { kind: "user" } });
  const result = await h.settle(true);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.text, "");
  assert.equal(result.reasoning, undefined);
  assert.deepEqual(result.usage, zero);
});
