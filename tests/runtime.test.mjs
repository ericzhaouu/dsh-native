import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDshConfig } from "../dist/config.js";
import { createDshRuntime } from "../dist/runtime.js";
import { startModelServer } from "./fixtures/model-server.mjs";

const SENTINEL = "not-a-real-key-dsh-native-test";

async function fixture(responder, body) {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-test-"));
  const model = await startModelServer(responder);
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root, allowedBaseUrls: [model.baseUrl],
    startupTimeoutMs: 30000, shutdownTimeoutMs: 10000, streamIdleTimeoutMs: 3000,
  }));
  const events = [];
  const input = {
    sessionId: "openclaw-test", runId: "run-1", workspaceDir: root,
    systemPrompt: "Only use the authorized tools. Literal {{keep_this}}.",
    prompt: "Read the fixture.", modelId: "deepseek-v4-pro",
    apiKey: SENTINEL, baseUrl: model.baseUrl, contextWindow: 1000000,
    maxTokens: 1000, thinking: "disabled", tools: [],
    signal: new AbortController().signal, assertActive() {},
    onEvent(event) { events.push(event); },
    async executeTool() { throw new Error("Unexpected tool execution."); },
  };
  try { await body({ root, model, runtime, input, events }); }
  finally {
    await runtime.dispose();
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test("real DSH boots with only host tools, streams, and resumes in a new child", { timeout: 90000 }, async () => {
  await fixture(async ({ body, send, finish }) => {
    if (!body.messages.some((message) => message.role === "tool")) {
      send({ role: "assistant", tool_calls: [{
        index: 0, id: "call_fixture", type: "function",
        function: { name: "read_fixture", arguments: '{"name":"sample"}' },
      }] });
      finish("tool_calls");
    } else {
      send({ role: "assistant", content: "Fixture " });
      send({ content: "complete." });
      finish();
    }
  }, async ({ root, runtime, model, input, events }) => {
    let calls = 0;
    input.tools = [{
      name: "read_fixture", description: "Read a fixture",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    }];
    input.executeTool = async (call) => {
      calls++;
      assert.equal(call.name, "read_fixture");
      assert.deepEqual(call.arguments, { name: "sample" });
      return { text: "fixture-content", isError: false };
    };
    const first = await runtime.run(input);
    assert.equal(first.text, "Fixture complete.");
    assert.equal(first.stopReason, "stop");
    assert.equal(first.toolCalls, 1);
    assert.equal(calls, 1);
    assert.ok(first.usage.output > 0);
    assert.ok(events.some((event) => event.type === "text"));
    for (const request of model.requests) {
      assert.deepEqual(request.body.tools.map((tool) => tool.function.name), ["read_fixture"]);
      assert.equal(request.body.messages[0].content, input.systemPrompt);
      assert.equal(request.headers.authorization, `Bearer ${SENTINEL}`);
      assert.equal(Object.hasOwn(request.body, "dsh_plugin_packages"), false);
      assert.equal(Object.hasOwn(request.body, "dsh_session_log"), false);
    }
    const second = await runtime.run({ ...input, runId: "run-2", prompt: "Continue the same session." });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(calls, 1);
    assert.ok(model.requests.at(-1).body.messages.some((message) => message.content === "fixture-content"));
    await assert.rejects(runtime.run({ ...input, runId: "run-2" }), /already submitted/);
    await assert.rejects(runtime.run({ ...input, runId: "run-1" }), /already submitted/);
    async function scan(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (/\.(json|jsonl|yml|yaml|log)$/.test(entry.name)) {
          assert.equal((await readFile(path, "utf8")).includes(SENTINEL), false, `Secret persisted in ${path}`);
        }
      }
    }
    await scan(root);
  });
});

test("unauthorized endpoint and revoked authority do not start model work", { timeout: 30000 }, async () => {
  await fixture(async ({ send, finish }) => { send({ content: "unexpected" }); finish(); },
    async ({ runtime, model, input }) => {
      await assert.rejects(runtime.run({ ...input, baseUrl: "https://not-allowed.example" }), /not explicitly allowed/);
      await assert.rejects(runtime.run({ ...input, assertActive() { throw new Error("revoked"); } }), /revoked/);
      assert.equal(model.requests.length, 0);
    });
});

test("cancel during host tool waits for its abort before settling", { timeout: 60000 }, async () => {
  await fixture(async ({ send, finish }) => {
    send({ role: "assistant", tool_calls: [{
      index: 0, id: "call_wait", type: "function", function: { name: "wait_fixture", arguments: "{}" },
    }] });
    finish("tool_calls");
  }, async ({ runtime, input }) => {
    const controller = new AbortController();
    let observedAbort = false;
    input.tools = [{ name: "wait_fixture", description: "Wait", parameters: { type: "object", properties: {} } }];
    input.signal = controller.signal;
    input.executeTool = async (_, signal) => {
      setTimeout(() => controller.abort(), 20);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      observedAbort = true;
      return { text: "cancelled", isError: true };
    };
    const result = await runtime.run(input);
    assert.equal(observedAbort, true);
    assert.equal(result.stopReason, "aborted");
  });
});
