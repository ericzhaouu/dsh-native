import assert from "node:assert/strict";
import test from "node:test";
import { assertCopilotReplaySafe, sanitizeCopilotStream } from "../dist/bridge/copilot-replay.js";

function history() {
  return {
    provider: "github-copilot", model: "gpt-6-astra", messages: [{
      role: "assistant", id: "assistant",
      source: {
        kind: "model", provider: "github-copilot", model: "gpt-6-astra",
        replayState: {
          response: { kind: "pi-ai", version: 2, api: "openai-responses",
            provider: "github-copilot", model: "gpt-6-astra", stopReason: "toolUse" },
          blocks: [{ type: "reasoning" }, { type: "tool-call" }],
        },
      },
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "tool-call", id: "call1", name: "read", arguments: "{}" },
      ],
    }],
  };
}

test("audits immutable replay without modifying canonical messages or exposing reasoning", () => {
  const input = history();
  const before = structuredClone(input);
  Object.freeze(input);
  assert.doesNotThrow(() => assertCopilotReplaySafe(input));
  assert.deepEqual(input, before);
});

test("rejects opaque, foreign, unsigned-without-envelope and misaligned replay", () => {
  const changes = [
    (m) => { m.content[1].id = "call1|fc_sensitive"; },
    (m) => { m.source.provider = "deepseek"; },
    (m) => { m.source.model = "gpt-5.6-sol"; },
    (m) => { delete m.source.replayState; },
    (m) => { m.source.replayState.response.responseId = "resp_sensitive"; },
    (m) => { m.source.replayState.response.api = "anthropic-messages"; },
    (m) => { m.source.replayState.blocks[0].thinkingSignature = "encrypted"; },
    (m) => { m.source.replayState.blocks.pop(); },
  ];
  for (const change of changes) {
    const input = history();
    change(input.messages[0]);
    assert.throws(() => assertCopilotReplaySafe(input));
  }
});

test("normalizes streamed IDs and strips native replay metadata before persistence", async () => {
  const chunks = await Array.fromAsync(sanitizeCopilotStream((async function* () {
    yield { type: "tool-call-delta", index: 0, id: "call1|fc_sensitive", name: "read", argumentsDelta: "{}" };
    yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call1|fc_sensitive", name: "read", arguments: "{}" } };
    yield {
      type: "finish", reason: { kind: "tool-calls" },
      replayState: {
        response: { ...history().messages[0].source.replayState.response, responseId: "resp_sensitive" },
        blocks: [{ type: "tool-call", thoughtSignature: "opaque" }],
      },
    };
  })()));
  assert.equal(chunks[0].id, "call1");
  assert.equal(chunks[1].block.id, "call1");
  assert.equal(chunks[2].replayState.response.responseId, undefined);
  assert.deepEqual(chunks[2].replayState.blocks, [{ type: "tool-call" }]);
  assert.equal(JSON.stringify(chunks).includes("opaque"), false);
});

test("rejects call-id collisions instead of mismatching tool results", async () => {
  await assert.rejects(Array.fromAsync(sanitizeCopilotStream((async function* () {
    yield { type: "tool-call-delta", index: 0, id: "call1|fc_first", name: "read", argumentsDelta: "{}" };
    yield { type: "tool-call-delta", index: 1, id: "call1|fc_second", name: "read", argumentsDelta: "{}" };
  })())), /Colliding/);
});

test("does not publish Copilot's omitted trailing summary separator", async () => {
  const chunks = await Array.fromAsync(sanitizeCopilotStream((async function* () {
    yield { type: "reasoning-delta", index: 0, text: "First " };
    yield { type: "reasoning-delta", index: 0, text: "part.\n\n" };
    yield { type: "reasoning-delta", index: 0, text: "Second part.\n\n" };
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: "First part.\n\nSecond part." } };
    yield { type: "text-delta", index: 1, text: "DSH_NATIVE_READY" };
    yield { type: "finish", reason: { kind: "stop" } };
  })()));
  assert.equal(chunks.filter((chunk) => chunk.type === "reasoning-delta").map((chunk) => chunk.text).join(""),
    "First part.\n\nSecond part.");
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta").text, "DSH_NATIVE_READY");
});

test("keeps pending whitespace without a canonical block and rejects real content rewrites", async () => {
  const chunks = await Array.fromAsync(sanitizeCopilotStream((async function* () {
    yield { type: "reasoning-delta", index: 0, text: "Reason \n" };
    yield { type: "finish", reason: { kind: "stop" } };
  })()));
  assert.equal(chunks.filter((chunk) => chunk.type === "reasoning-delta").map((chunk) => chunk.text).join(""), "Reason \n");
  await assert.rejects(Array.fromAsync(sanitizeCopilotStream((async function* () {
    yield { type: "reasoning-delta", index: 0, text: "Original " };
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: "Different" } };
  })())), /rewrote/);
});
