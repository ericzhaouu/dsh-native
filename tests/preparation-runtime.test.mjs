import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDshConfig } from "../dist/config.js";
import { PREPARATION_TOOL_NAME, createPreparationTool, renderPreparationInstructions } from "../dist/preparation.js";
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

async function fixture(responder, run, { shutdownTimeoutMs = 10000, expectUnconfirmed = false } = {}) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), `.preparation-runtime-${randomUUID()}`);
  await mkdir(root);
  const model = await startModelServer(responder);
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root, allowedBaseUrls: [model.baseUrl],
    startupTimeoutMs: 30000, shutdownTimeoutMs, streamIdleTimeoutMs: 3000,
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
    if (expectUnconfirmed) {
      await assert.rejects(runtime.dispose(), (error) => error.code === "DSH_TERMINATION_UNCONFIRMED");
    } else await runtime.dispose();
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

test("scripted explanation and artifact decisions complete with zero host dispatches", { timeout: 60000 }, async () => {
  for (const mode of ["chat", "draft"]) {
    const prompt = mode === "chat"
      ? "Explain why evidence is insufficient; do not verify the claim or use the network."
      : "Write a source checklist for later verification; do not verify the claim or use the network.";
    const reply = mode === "chat"
      ? "The source material is missing, so the claim has not been verified."
      : "Source checklist: original material and corroborating evidence. Verification remains pending.";
    let calls = 0;
    await fixture(async ({ body, send, finish, index }) => {
      if (index === 0) {
        assert.deepEqual(toolNames(body), [PREPARATION_TOOL_NAME]);
        assert.match(JSON.stringify(body.messages), /Prioritize the user's immediate authorized output/);
        toolCall(send, finish, PREPARATION_TOOL_NAME, decision({
          mode, task: mode === "chat" ? "none" : "new", goal: prompt,
          deliverables: mode === "draft" ? ["A source checklist"] : [],
          constraints: ["No network or verification."], enhancedPrompt: prompt,
          evidence: { source: "current", quote: prompt },
        }), `${mode}-control`);
        return;
      }
      assert.equal(index, 1);
      assert.deepEqual(toolNames(body), []);
      send({ role: "assistant", content: reply });
      finish();
    }, async ({ runtime, model, input }) => {
      input.prompt = prompt;
      input.taskPreparation.userText = prompt;
      input.systemPrompt += `\n\n${renderPreparationInstructions(policy)}`;
      input.executeTool = async () => { calls++; return { text: "unexpected", isError: false }; };
      const result = await runtime.run(input);
      assert.equal(result.text, reply);
      assert.equal(result.preparation.decision.mode, mode);
      assert.deepEqual(result.preparation.allowedTools, []);
      assert.equal(result.toolCalls, 0, "the preparation control is not a host call");
      assert.equal(calls, 0);
      assert.equal(model.requests.length, 2);
    });
  }
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
        assert.equal(binding.failureDiagnostic?.version, 1);
        assert.equal(binding.failureDiagnostic?.operation, "run");
        assert.equal(binding.failureDiagnostic?.preparation?.requested, name === "forged quote" || Boolean(callbackFailure));
        assert.equal(binding.failureDiagnostic?.preparation?.resolved, false);
        assert.equal(JSON.stringify(binding.failureDiagnostic).includes(input.apiKey), false);
        await assert.rejects(runtime.run({ ...input, runId: "retry-invalid" }), /uncertain/);
        assert.equal(model.requests.length, 1);
      });
    });
  }
});

test("delayed preparation callback cancellation blocks with bounded diagnostics", { timeout: 60000 }, async () => {
  let callbackStarted;
  const started = new Promise((resolve) => { callbackStarted = resolve; });
  let releaseCallback;
  const release = new Promise((resolve) => { releaseCallback = resolve; });
  await fixture(async ({ send, finish, index }) => {
    assert.equal(index, 0);
    toolCall(send, finish, PREPARATION_TOOL_NAME, decision({ mode: "chat", task: "none" }), "delayed-control");
  }, async ({ runtime, model, input, statePath }) => {
    const controller = new AbortController();
    input.signal = controller.signal;
    input.onPreparationDecision = async () => {
      callbackStarted();
      await release;
    };
    const run = runtime.run(input);
    await started;
    controller.abort(new Error("synthetic preparation cancellation"));
    releaseCallback();
    await assert.rejects(run, /preparation|cancel|aborted|interrupted/i);
    assert.equal(model.requests.length, 1);
    const binding = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(binding.status, "blocked");
    assert.equal(Object.hasOwn(binding, "taskPreparation"), false);
    assert.deepEqual(binding.failureDiagnostic.preparation, {
      requested: true, resolved: false, failed: true, phase: "callback",
    });
    assert.equal(JSON.stringify(binding).includes(input.apiKey), false);
  });
});

test("frozen preparation errors are not masked and do not persist callback text", { timeout: 60000 }, async () => {
  const failure = Object.freeze(new Error("parent preparation callback failed: PRIVATE_CALLBACK_CONTENT"));
  await fixture(async ({ send, finish, index }) => {
    assert.equal(index, 0);
    toolCall(send, finish, PREPARATION_TOOL_NAME, decision(), "frozen-callback");
  }, async ({ runtime, input, statePath }) => {
    input.onPreparationDecision = () => { throw failure; };
    await assert.rejects(runtime.run(input), (error) => {
      assert.equal(error.message, failure.message);
      assert.equal(error.name, failure.name);
      return true;
    });
    const binding = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(binding.status, "blocked");
    assert.equal(binding.failureDiagnostic.reason, "preparation-failed");
    assert.equal(binding.failureDiagnostic.preparation.phase, "callback");
    assert.equal(JSON.stringify(binding).includes("PRIVATE_CALLBACK_CONTENT"), false);
  });
});

test("unsettled preparation cancellation retains a lock and a callback-phase diagnostic", { timeout: 30000 }, async () => {
  let callbackStarted;
  let releaseCallback;
  const started = new Promise((resolve) => { callbackStarted = resolve; });
  const release = new Promise((resolve) => { releaseCallback = resolve; });
  await fixture(async ({ send, finish, index }) => {
    assert.equal(index, 0);
    toolCall(send, finish, PREPARATION_TOOL_NAME, decision({ mode: "chat", task: "none" }), "unsettled-control");
  }, async ({ runtime, model, input, statePath, root }) => {
    const controller = new AbortController();
    input.signal = controller.signal;
    input.onPreparationDecision = async () => { callbackStarted(); await release; };
    const run = runtime.run(input);
    const rejected = assert.rejects(run, (error) => error.code === "DSH_TERMINATION_UNCONFIRMED");
    try {
      await started;
      controller.abort(new Error("PRIVATE_CANCELLATION_DETAIL"));
      await rejected;
      const binding = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(binding.status, "blocked");
      assert.equal(binding.failureDiagnostic.reason, "termination-unconfirmed");
      assert.equal(binding.failureDiagnostic.phase, "shutdown");
      assert.equal(binding.failureDiagnostic.preparation.phase, "callback");
      assert.equal(binding.failureDiagnostic.preparation.requested, true);
      assert.equal(binding.failureDiagnostic.preparation.resolved, false);
      assert.doesNotMatch(JSON.stringify(binding), /PRIVATE_CANCELLATION_DETAIL/);
      const key = createHash("sha256").update(input.sessionId).digest("hex");
      assert.ok(await readFile(join(root, key, "owner.lock"), "utf8"));
      await assert.rejects(runtime.run({ ...input, signal: new AbortController().signal, runId: "do-not-replay" }),
        /already has an owner|unconfirmed|uncertain/i);
      assert.equal(model.requests.length, 1, "retained ownership must prevent another model request");
    } finally {
      releaseCallback();
    }
  }, { shutdownTimeoutMs: 500, expectUnconfirmed: true });
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
