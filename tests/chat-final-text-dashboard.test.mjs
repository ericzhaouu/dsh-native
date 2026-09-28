import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

const byteCases = [
  { id: "lf", name: "one trailing LF", text: "Single trailing newline\n" },
  { id: "lfs", name: "multiple leading and trailing LFs", text: "\n\nFirst line\nSecond line\n\n\n" },
  { id: "crlf", name: "CRLF without line-ending normalization", text: "\r\nFirst\r\nSecond\r\n\r\n" },
  { id: "spaces-tabs", name: "leading and trailing spaces and tabs", text: "\t  Leading\tmiddle  trailing \t " },
  { id: "code", name: "fenced code and Markdown hardbreaks",
    text: "Before  \n```text\n\tindented  \nkeep\tthese spaces \t\n```\nAfter  \n\n" },
  { id: "chinese", name: "Chinese and multibyte UTF-8", text: "\t 中文：逐字保留  \r\n第二行：你好，世界。🙂\t\n\n" },
  { id: "historic-4500-lf", name: "historical x.repeat(4500) plus LF", text: "x".repeat(4500) + "\n" },
];

test("pinned native Dashboard fails before inference when the final-text companion is absent",
  { timeout: 300000 }, async () => {
    const gateway = await startDashboardGateway(() => {
      assert.fail("Missing companion must never reach even the synthetic provider");
    }, { hostTools: [], chatFinalTextPatch: false });
    try {
      const sessionKey = `agent:${gateway.agentId}:missing-final-text`;
      const runId = "missing-final-text-companion";
      await gateway.chat.request("chat.send", {
        sessionKey, agentId: gateway.agentId, message: "Synthetic preflight-only turn.",
        thinking: "off", idempotencyKey: runId,
      }, { timeoutMs: 120000 });
      await assert.rejects(gateway.waitForFinal(sessionKey, runId), /chat-final-text companion required/);
      assert.equal(gateway.responses.requests.length, 0);
      const frames = gateway.eventsForRun(sessionKey, runId);
      assert.equal(frames.some((frame) => frame.event === "chat" && frame.payload.state === "final"), false);
      assert.equal(frames.some((frame) => frame.payload.stream === "lifecycle" &&
        ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), false);
    } finally { await gateway.close(); }
  });

function assertBytes(actual, expected, label) {
  assert.equal(typeof actual, "string", `${label}: actual text must exist`);
  assert.equal(typeof expected, "string", `${label}: expected text must exist`);
  assert.deepEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"), label);
}

function assertByteDelivery(gateway, turn, final, settled) {
  const { sessionKey, runId, expected } = turn;
  gateway.assertTurnHealthy(sessionKey, runId);
  const key = `dsh-native:${runId}:assistant`;
  const assistants = settled.history.messages.filter((message) => message.role === "assistant" &&
    (message.idempotencyKey ?? message.__openclaw?.idempotencyKey) === key);
  assert.equal(assistants.length, 1, "Exactly one canonical native assistant for this run");
  assert.equal(assistants[0], settled.assistant);
  const canonical = messageText(settled.assistant);
  assertBytes(canonical, expected, `${runId}: canonical history preserves the expected bytes`);

  const frames = gateway.eventsForRun(sessionKey, runId);
  const finals = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final");
  assert.equal(finals.length, 1, "Exactly one actual Dashboard final, not a fallback/mirror final");
  assert.equal(finals[0], final);
  assert.equal(final.payload.message?.role, "assistant", "A status-only final is not delivery");
  assertBytes(messageText(final.payload.message), canonical, `${runId}: actual final equals canonical bytes`);

  const deltas = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "delta");
  assert.ok(deltas.length > 0, "Canonical history cannot substitute for a live Dashboard delta");
  let accumulated = "";
  for (const frame of deltas) {
    assert.equal(frame.payload.message?.role, "assistant");
    assert.equal(typeof frame.payload.deltaText, "string");
    accumulated = frame.payload.replace ? frame.payload.deltaText : accumulated + frame.payload.deltaText;
    assertBytes(messageText(frame.payload.message), accumulated, `${runId}: delta snapshot matches wire increments`);
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final), "No delta after final");
  }
  // Compare the received last snapshot itself, not just a reconstructed stream or a history fetch.
  const lastDelta = messageText(deltas.at(-1).payload.message);
  assertBytes(lastDelta, canonical, `${runId}: actual last delta equals canonical bytes`);
  assertBytes(messageText(final.payload.message), lastDelta, `${runId}: final equals last delta bytes`);

  const commits = frames.filter((frame) => frame.event === "agent" &&
    frame.payload.stream === "assistant" && frame.payload.data?.itemId === key);
  assert.ok(commits.length > 0, "The genuine native committed snapshot must reach the Control UI client");
  assertBytes(commits.at(-1).payload.data.text, canonical, `${runId}: committed agent snapshot equals canonical bytes`);
  for (const frame of commits) {
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final), "No committed snapshot after final");
  }
  assert.deepEqual(frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "lifecycle" &&
    ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), []);
  assert.equal(settled.binding.value.status, "ready");
  assert.equal(settled.binding.value.lastRunId, runId);
  assert.ok(!settled.history.inFlightRun, "Check bytes only after native persistence and host dispatch settle");
}

async function sendTurn(gateway, turn) {
  const response = await gateway.chat.request("chat.send", {
    sessionKey: turn.sessionKey,
    agentId: gateway.agentId,
    message: `Return the local synthetic byte-regression answer for ${turn.runId}; do not use tools.`,
    thinking: "medium",
    idempotencyKey: turn.runId,
  }, { timeoutMs: 120000 });
  assert.equal(response?.status, "started");
  assert.equal(response?.runId, turn.runId);
  const final = await gateway.waitForFinal(turn.sessionKey, turn.runId);
  const settled = await gateway.waitForDurableSettle(turn.sessionKey, turn.runId);
  assertByteDelivery(gateway, turn, final, settled);
  return { turn, final, settled };
}

function assertSyntheticRequest(body) {
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "medium");
  assert.deepEqual(body.tools ?? [], []);
  assert.equal(body.input[0].role, "developer");
  assert.match(body.input[0].content, /DSH callback-only host/);
}

test("Dashboard native finals and last deltas preserve canonical UTF-8 bytes", { timeout: 620000 }, async (t) => {
  const gateway = await startDashboardGateway(({ body, index, text, finish }) => {
    assertSyntheticRequest(body);
    assert.ok(index < byteCases.length, "No unexpected retry or fallback provider requests");
    text(byteCases[index].text);
    finish();
  }, { hostTools: [] });
  try {
    assert.equal(gateway.agentPinned, true, "Exercise the native Agent runtime pin and patched SDK");
    const sessionKey = `agent:${gateway.agentId}:final-byte-matrix`;
    const completed = [];
    for (const [index, entry] of byteCases.entries()) {
      await t.test(entry.name, async () => {
        const result = await sendTurn(gateway, {
          sessionKey, runId: `final-byte-${entry.id}`, expected: entry.text,
        });
        completed.push(result);
        assert.equal(gateway.responses.requests.length, index + 1, "Exactly one local provider request per turn");
        const assistants = result.settled.history.messages.filter((message) => message.role === "assistant");
        assert.equal(assistants.length, index + 1, "No duplicate or delivery-mirror assistant in history");
        assistants.forEach((message, turnIndex) => {
          assertBytes(messageText(message), byteCases[turnIndex].text, "Later turns cannot mutate earlier answer bytes");
        });
      });
    }
    for (const { turn, final, settled } of completed) assertByteDelivery(gateway, turn, final, settled);
    assert.equal(completed.length, byteCases.length);
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});

async function assertNativeReasoning(binding, reasoning, answer) {
  const sessions = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^session\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        const bytes = await readFile(path);
        const text = (entry.name.endsWith(".zstd") ? zstdDecompressSync(bytes) : bytes).toString("utf8");
        const [header, ...rows] = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
        if (header.type === "session" && header.id === binding.value.sessionId) sessions.push(rows);
      }
    }
  };
  // Only this gateway's synthetic native home; never a user's canonical history.
  await visit(join(dirname(binding.path), "home"));
  assert.equal(sessions.length, 1);
  const assistants = sessions[0].filter((row) => row.type === "assistant/message").map((row) => row.data.message);
  assert.equal(assistants.length, 1);
  const reasoningBlocks = assistants[0].content.filter((block) => block.type === "reasoning");
  assert.equal(reasoningBlocks.length, 1, "The local provider's nontext reasoning must actually reach native persistence");
  assertBytes(reasoningBlocks[0].text, reasoning, "Native nontext reasoning was emitted independently of assistant text");
  assertBytes(messageText(assistants[0]), answer, "Private native history retains the synthetic pre-redaction answer");
}

test("Dashboard native final bytes follow redacted multi-block persistence, not nontext reasoning",
  { timeout: 620000 }, async () => {
    const privateReasoning = "PRIVATE-DASHBOARD-FINAL-BYTE-REASONING";
    const suffix = "\r\n```text\r\n\t中文代码  \r\n```\r\n尾行 \t\n\n";
    const original = "\t  SAFE-PREFIX FINAL-BYTE-SECRET SAFE-SUFFIX" + suffix;
    const expected = "\t  SAFE-PREFIX *** SAFE-SUFFIX" + suffix;
    const gateway = await startDashboardGateway(({ body, index, reasoning, text, finish }) => {
      assert.equal(index, 0, "No retry or fallback provider request");
      assertSyntheticRequest(body);
      reasoning(privateReasoning);
      text(original);
      finish();
    }, {
      hostTools: [],
      splitAssistantTextBlocks: true,
      redactTranscriptIdentity: true,
      redactTranscriptPatterns: ["FINAL-BYTE-SECRET"],
    });
    try {
      const turn = {
        sessionKey: `agent:${gateway.agentId}:final-byte-multiple-blocks`,
        runId: "final-byte-redacted-multiple-blocks",
        expected,
      };
      const { final, settled } = await sendTurn(gateway, turn);
      assert.equal(settled.history.messages.filter((message) => message.role === "assistant").length, 1);
      assert.equal(settled.assistant.provider, "***", "Use real SDK persistence redaction");
      assert.equal(settled.assistant.model, "***");
      const blocks = settled.assistant.content;
      assert.ok(Array.isArray(blocks));
      // Native canonical assistants only permit text blocks; nontext is exercised in the provider/native history.
      assert.ok(blocks.every((block) => block.type === "text" && typeof block.text === "string"));
      assert.equal(blocks.length, 7, "The before_message_write hook must really rewrite persisted block structure");
      for (const index of [0, 2, 4, 6]) assertBytes(blocks[index].text, "", "Empty persisted block is retained");
      assert.ok(blocks[1].text.endsWith("\r"), "The hook splits a CRLF across text blocks");
      assert.ok(blocks[3].text.startsWith("\n"));
      assertBytes(blocks[5].text, "\n", "The trailing LF is its own persisted text block");
      assert.ok(blocks.filter((block) => block.text.length > 0).length > 1);
      for (const message of [settled.assistant, final.payload.message]) {
        assert.doesNotMatch(messageText(message), /FINAL-BYTE-SECRET|PRIVATE-DASHBOARD-FINAL-BYTE-REASONING/);
      }
      for (const frame of gateway.eventsForRun(turn.sessionKey, turn.runId)) {
        if (frame.event === "chat" && ["delta", "final"].includes(frame.payload.state)) {
          assert.equal(messageText(frame.payload.message).includes(privateReasoning), false,
            "Nontext reasoning must not become Dashboard answer text");
        }
      }
      assert.equal(gateway.responses.requests.length, 1);
      await assertNativeReasoning(settled.binding, privateReasoning, original);
      assertByteDelivery(gateway, turn, final, settled);
      await gateway.assertHealthyLogs();
    } finally {
      await gateway.close();
    }
  });
