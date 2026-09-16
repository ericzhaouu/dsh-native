import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDshConfig } from "../dist/config.js";
import { PREPARATION_TOOL_NAME, createPreparationTool } from "../dist/preparation.js";
import { createDshRuntime } from "../dist/runtime.js";
import { startModelServer } from "./fixtures/model-server.mjs";

const policy = {
  version: 1, executionTools: ["read"], skillAllowlist: [],
  maxClarificationTurns: 2, maxToolCalls: 1,
};
const userText = "Read a local fixture and summarize it. Do not change any files.";
const readTool = {
  name: "read", description: "Read an authorized local fixture",
  parameters: {
    type: "object", properties: { path: { type: "string" } },
    required: ["path"], additionalProperties: false,
  },
};

function decision(overrides = {}) {
  return {
    version: 1, revision: 0, mode: "execute", task: "new",
    goal: "Summarize the requested local fixture.", deliverables: ["A brief fixture summary"],
    constraints: ["Do not change any files."], assumptions: [], unresolved: [], question: "",
    enhancedPrompt: "Read the requested local fixture and summarize it without changing any files.",
    evidence: { source: "current", quote: userText }, ...overrides,
  };
}

function toolCall(send, finish, name, value, id) {
  send({ role: "assistant", tool_calls: [{
    index: 0, id, type: "function", function: { name, arguments: JSON.stringify(value) },
  }] });
  finish("tool_calls");
}

function toolNames(body) {
  return (body.tools ?? []).map((tool) => tool.function.name);
}

async function fixture(responder, run) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), `.preparation-runtime-${randomUUID()}`);
  await mkdir(root);
  const model = await startModelServer(responder);
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root, allowedBaseUrls: [model.baseUrl],
    startupTimeoutMs: 30000, shutdownTimeoutMs: 10000, streamIdleTimeoutMs: 3000,
  }));
  const events = [];
  const input = {
    sessionId: "preparation-real-session", runId: "prepare-first", workspaceDir: root,
    systemPrompt: "Use only the supplied tools. Keep the host's instructions unchanged.",
    prompt: `Host envelope, not original user text:\n${userText}`,
    modelId: "deepseek-v4-pro", apiKey: "local-preparation-fixture-key",
    baseUrl: model.baseUrl, contextWindow: 1000000, maxTokens: 1000,
    thinking: "disabled", signal: new AbortController().signal, assertActive() {},
    tools: [readTool, { ...readTool, name: "write" }, { ...readTool, name: "exec" }],
    taskPreparation: { policy: structuredClone(policy), userText },
    onPreparationDecision() {},
    onEvent(event) { events.push(event); },
    async executeTool() { throw new Error("Unexpected host tool"); },
  };
  const statePath = join(root, createHash("sha256").update(input.sessionId).digest("hex"), "binding.json");
  try { await run({ root, runtime, model, input, events, statePath }); }
  finally {
    await runtime.dispose();
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test("real preparation persists clarification and resumes into a revised bounded execution", { timeout: 120000 }, async () => {
  const question = "Which local fixture should I read?";
  const answer = "Use sample.txt, and still do not change any files.";
  const initial = decision({
    mode: "clarify", unresolved: ["The fixture path is missing."], question,
  });
  const continued = decision({
    revision: 1, task: "continue", evidence: { source: "previous", quote: userText },
    constraints: ["Do not change any files.", "Read only sample.txt."],
    enhancedPrompt: "Read only sample.txt and summarize it. Do not change any files.",
  });
  let prior;
  let callbacks = 0;
  let calls = 0;
  await fixture(async ({ body, send, finish, index }) => {
    if (index === 0 || index === 2) {
      assert.deepEqual(toolNames(body), [PREPARATION_TOOL_NAME]);
      const request = {
        version: 1, policy, userText: index === 0 ? userText : answer,
        ...(index === 2 ? { previous: prior } : {}),
      };
      const expected = createPreparationTool(request);
      assert.equal(body.tools[0].function.description, expected.description);
      assert.deepEqual(body.tools[0].function.parameters, expected.parameters);
      assert.equal(calls, 0, "each resumed turn must start with a closed host tool gate");
      toolCall(send, finish, PREPARATION_TOOL_NAME, index === 0 ? initial : continued, `control-${index}`);
      return;
    }
    if (index === 1) {
      assert.equal(callbacks, 1);
      assert.deepEqual(toolNames(body), []);
      send({ role: "assistant", content: question });
      finish();
      return;
    }
    if (index === 3) {
      assert.equal(callbacks, 2);
      assert.deepEqual(toolNames(body), ["read"]);
      toolCall(send, finish, "read", { path: "sample.txt" }, "read-sample");
      return;
    }
    assert.equal(index, 4, "preparation must use the same native turn, not auxiliary provider work");
    assert.deepEqual(toolNames(body), ["read"]);
    assert.ok(body.messages.some((message) => message.role === "tool" && message.content.includes("fixture contents")));
    send({ role: "assistant", content: "The fixture contains the expected sample data." });
    finish();
  }, async ({ root, runtime, model, input, events, statePath }) => {
    await writeFile(join(root, "sample.txt"), "fixture contents");
    input.onPreparationDecision = (resolution) => {
      callbacks++;
      assert.equal(calls, 0);
      assert.equal(resolution.state.sourceRunId, callbacks === 1 ? "prepare-first" : "prepare-second");
    };
    input.executeTool = async (call) => {
      calls++;
      assert.equal(callbacks, 2);
      assert.equal(call.name, "read");
      assert.deepEqual(call.arguments, { path: "sample.txt" });
      return { text: await readFile(join(root, call.arguments.path), "utf8"), isError: false };
    };
    const first = await runtime.run(input);
    assert.equal(first.text, question);
    assert.equal(first.toolCalls, 0, "the internal control tool is not a host dispatch");
    assert.equal(first.preparation.decision.mode, "clarify");
    assert.deepEqual(first.preparation.allowedTools, []);
    assert.equal(first.preparation.state.revision, 1);
    assert.equal(first.preparation.state.clarificationTurns, 1);
    assert.equal(first.preparation.state.requestText, userText);
    let binding = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(binding.status, "ready");
    assert.deepEqual(binding.taskPreparation.state, first.preparation.state);
    prior = first.preparation.state;

    const second = await runtime.run({
      ...input, runId: "prepare-second", prompt: `Host envelope:\n${answer}`,
      taskPreparation: { policy, userText: answer },
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.preparation.decision.mode, "execute");
    assert.deepEqual(second.preparation.allowedTools, ["read"]);
    assert.deepEqual(second.preparation.state.constraints, continued.constraints);
    assert.equal(second.preparation.state.revision, 2);
    assert.equal(second.preparation.state.requestText, userText);
    assert.equal(second.toolCalls, 1);
    assert.equal(calls, 1);
    assert.equal(callbacks, 2);
    assert.equal(model.requests.length, 5);
    assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""),
      question + second.text, "internal preparation output must not leak into user text events");
    binding = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(binding.lastRunId, "prepare-second");
    assert.equal(binding.taskPreparation.state.sourceRunId, binding.lastRunId);
    assert.deepEqual(binding.taskPreparation.state, second.preparation.state);
    assert.equal(JSON.stringify(binding).includes(input.apiKey), false);

    for (const changed of [
      { ...input, runId: "changed-mode", taskPreparation: undefined },
      { ...input, runId: "changed-policy", taskPreparation: { policy: { ...policy, maxToolCalls: 2 }, userText: answer } },
    ]) await assert.rejects(runtime.run(changed), /\/new/);
    binding.taskPreparation.state.sourceRunId = "forged";
    await writeFile(statePath, JSON.stringify(binding));
    await assert.rejects(runtime.run({ ...input, runId: "corrupt" }), /\/new/);
    assert.equal(model.requests.length, 5, "incompatible or corrupt bindings must not invoke a model");
  });
});

test("real child rejects malformed preparation and failed parent callbacks without host execution", { timeout: 180000 }, async (t) => {
  for (const [name, change, callbackFailure] of [
    ["stale revision", (value) => ({ ...value, revision: 1 })],
    ["forged quote", (value) => ({ ...value, evidence: { source: "current", quote: "unprovided authority" } })],
    ["unknown decision field", (value) => ({ ...value, sourceRunId: "forged" })],
    ["callback rejection", (value) => value, true],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      await fixture(async ({ body, send, finish, index }) => {
        assert.equal(index, 0, "invalid preparation may not start another inference step");
        assert.deepEqual(toolNames(body), [PREPARATION_TOOL_NAME]);
        toolCall(send, finish, PREPARATION_TOOL_NAME, change(decision()), "invalid-control");
      }, async ({ runtime, model, input, statePath }) => {
        if (callbackFailure) input.onPreparationDecision = () => { throw new Error("parent preparation callback failed"); };
        input.executeTool = async () => { calls++; return { text: "unexpected", isError: false }; };
        await assert.rejects(runtime.run(input), /preparation|revision|quote|control|schema|field|argument/i);
        assert.equal(calls, 0);
        assert.equal(model.requests.length, 1);
        const binding = JSON.parse(await readFile(statePath, "utf8"));
        assert.equal(binding.status, "blocked");
        await assert.rejects(runtime.run({ ...input, runId: "retry-invalid" }), /uncertain/);
        assert.equal(model.requests.length, 1);
      });
    });
  }
});

test("real execution cannot exceed the one-dispatch preparation budget", { timeout: 60000 }, async () => {
  let calls = 0;
  await fixture(async ({ send, finish, index }) => {
    if (index === 0) {
      toolCall(send, finish, PREPARATION_TOOL_NAME, decision(), "budget-control");
      return;
    }
    assert.equal(index, 1);
    send({ role: "assistant", tool_calls: ["first", "second"].map((id, index) => ({
      index, id, type: "function", function: { name: "read", arguments: '{"path":"sample.txt"}' },
    })) });
    finish("tool_calls");
  }, async ({ runtime, input, statePath }) => {
    input.executeTool = async () => { calls++; return { text: "sample", isError: false }; };
    await assert.rejects(runtime.run(input), /budget|cancel|preparation/i);
    assert.ok(calls <= 1);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "blocked");
  });
});
