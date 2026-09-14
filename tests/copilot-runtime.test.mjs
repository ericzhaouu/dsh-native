import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDshConfig } from "../dist/config.js";
import { createDshRuntime } from "../dist/runtime.js";
import { startResponsesServer } from "./fixtures/responses-server.mjs";

const TOKEN = "copilot-fixture-token-not-real";

async function fixture(responder, action) {
  const root = await mkdtemp(join(tmpdir(), "dsh-copilot-test-"));
  const server = await startResponsesServer(responder);
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root, allowedCopilotBaseUrls: [server.baseUrl],
    startupTimeoutMs: 120000, shutdownTimeoutMs: 10000, streamIdleTimeoutMs: 5000,
  }));
  const events = [];
  const input = {
    provider: "github-copilot", sessionId: "openclaw-copilot", runId: "first", workspaceDir: root,
    modelId: "gpt-6-astra", modelName: "Account Astra", baseUrl: server.baseUrl, apiKey: TOKEN,
    contextWindow: 1000000, maxTokens: 2000, thinking: "enabled", reasoningEffort: "xhigh",
    reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    headers: {
      "Copilot-Integration-Id": "copilot-developer-cli", "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0", "Openai-Organization": "github-copilot",
      "Accept-Encoding": "identity", "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    systemPrompt: "Use only host tools. Preserve literal {{syntax}}.", prompt: "Read the fixture.",
    tools: [{
      name: "read_fixture", description: "Read fixture text",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    }],
    signal: new AbortController().signal, assertActive() {},
    onEvent(event) { events.push(event); },
    async executeTool(call) {
      assert.equal(call.callId, "call_fixture");
      assert.equal(call.name, "read_fixture");
      assert.deepEqual(call.arguments, { name: "sample" });
      return { text: "COPILOT-HOST-RESULT", isError: false };
    },
  };
  try { await action({ input, root, runtime, server, events }); }
  finally { await runtime.dispose(); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}

test("real DSH Copilot Responses retains host auth, tools and history without opaque replay", { timeout: 300000 }, async () => {
  await fixture(async ({ body, reasoning, tool, text, finish }) => {
    if (body.input.some((item) => item.type === "function_call_output")) text("COPILOT-GPT-OK");
    else { reasoning(); tool("read_fixture", { name: "sample" }); }
    finish();
  }, async ({ input, root, runtime, server, events }) => {
    const first = await runtime.run(input);
    assert.equal(first.text, "COPILOT-GPT-OK");
    assert.equal(first.toolCalls, 1);
    assert.equal(first.usage.output, 16);
    assert.equal(server.requests.length, 2);
    assert.ok(events.some((event) => event.type === "reasoning"));
    assert.ok(events.some((event) => event.type === "text"));
    for (const { body, headers } of server.requests) {
      assert.equal(headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(headers["copilot-integration-id"], "copilot-developer-cli");
      assert.equal(headers["editor-version"], "vscode/1.107.0");
      assert.equal(headers["editor-plugin-version"], "copilot-chat/0.35.0");
      assert.equal(headers["openai-organization"], "github-copilot");
      assert.equal(headers["accept-encoding"], "identity");
      assert.match(headers["user-agent"], /deepseek.*harness/i);
      assert.equal(body.model, "gpt-6-astra");
      assert.equal(body.max_output_tokens, 2000);
      assert.equal(body.reasoning.effort, "xhigh");
      assert.equal(body.store, false);
      assert.deepEqual(body.tools.map((item) => item.name), ["read_fixture"]);
    }
    assert.equal(server.requests[0].headers["x-initiator"], "user");
    assert.equal(server.requests[1].headers["x-initiator"], "agent");
    const replay = server.requests[1].body.input;
    assert.equal(replay.some((item) => item.type === "reasoning"), false);
    assert.equal(JSON.stringify(replay).includes("private planning"), false);
    const call = replay.find((item) => item.type === "function_call");
    const result = replay.find((item) => item.type === "function_call_output");
    assert.equal(call.id, undefined);
    assert.equal(call.call_id, "call_fixture");
    assert.equal(result.call_id, "call_fixture");
    const second = await runtime.run({ ...input, runId: "second", prompt: "Continue this conversation." });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.text, "COPILOT-GPT-OK");
    assert.equal(server.requests.length, 3);
    assert.equal(server.requests[2].headers["x-initiator"], "user");
    assert.equal(JSON.stringify(server.requests[2].body).includes("encrypted_sensitive"), false);
    await assert.rejects(runtime.run({ ...input, runId: "changed-account", apiKey: "another-account-token" }), /route or account changed/);
    await assert.rejects(runtime.run({ ...input, runId: "changed-model", modelId: "gpt-5.6-sol" }), /route or account changed/);
    assert.equal(server.requests.length, 3);
    async function scan(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await scan(path);
        else if (/\.(json|jsonl|yaml|yml)$/.test(item.name)) {
          const contents = await readFile(path, "utf8");
          for (const forbidden of [TOKEN, "encrypted_sensitive", "fc_sensitive", "msg_sensitive", "resp_sensitive_"]) {
            assert.equal(contents.includes(forbidden), false, `${forbidden} persisted in ${path}`);
          }
        }
      }
    }
    await scan(root);
  });
});

test("Copilot host-tool cancellation drains, and tokens cannot cross provider allowlists", { timeout: 150000 }, async () => {
  await fixture(async ({ tool, finish }) => { tool("read_fixture", { name: "sample" }); finish(); },
    async ({ input, runtime, server }) => {
      await assert.rejects(runtime.run({ ...input, provider: "deepseek" }), /not explicitly allowed/);
      assert.equal(server.requests.length, 0);
      const controller = new AbortController();
      let drained = false;
      const result = await runtime.run({
        ...input, signal: controller.signal,
        async executeTool(_call, signal) {
          setTimeout(() => controller.abort(), 10);
          await new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }));
          drained = true;
          return { text: "cancelled", isError: true };
        },
      });
      assert.equal(drained, true);
      assert.equal(result.stopReason, "aborted");
    });
});
