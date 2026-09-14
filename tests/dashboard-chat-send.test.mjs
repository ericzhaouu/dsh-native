import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

async function assertInheritedAgentPin(gateway) {
  const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
  assert.equal(config.agents.defaults.model.primary, gateway.modelRef);
  assert.deepEqual(config.agents.entries[gateway.agentId].runtime, { type: "embedded", harness: "dsh-native" });
  assert.equal(config.agents.defaults.models, undefined);
  assert.equal(config.agents.entries[gateway.agentId].models, undefined);
  assert.equal(config.agents.entries[gateway.agentId].model, undefined);
  assert.ok(config.models.providers["github-copilot"].models.every((model) =>
    model.agentRuntime === undefined && model.runtime === undefined));
}

function assertNoFallback(gateway, sessionKey, runId, history) {
  const frames = gateway.eventsForRun(sessionKey, runId);
  assert.deepEqual(frames.filter((frame) => frame.event === "agent" &&
    frame.payload.stream === "lifecycle" &&
    ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), [],
  "Redacted transcript identity must not cause a host model-fallback lifecycle event");
  for (const frame of frames) {
    assert.doesNotMatch(messageText(frame.payload.message), /model fallback|selected model unavailable/i);
    if (typeof frame.payload.data?.text === "string") {
      assert.doesNotMatch(frame.payload.data.text, /model fallback|selected model unavailable/i);
    }
  }
  for (const message of history.messages) {
    assert.doesNotMatch(messageText(message), /model fallback|selected model unavailable/i);
  }
  assert.equal(history.sessionInfo.modelProvider, "github-copilot");
  assert.equal(history.sessionInfo.model, "gpt-6-astra");
  assert.equal(history.sessionInfo.activeModelProvider, undefined, "No fallback provider should be active");
  assert.equal(history.sessionInfo.activeModel, undefined, "No fallback model should be active");
}

function assertDeliveredOnce(gateway, sessionKey, runId, expectedText, final) {
  gateway.assertTurnHealthy(sessionKey, runId);
  const frames = gateway.eventsForRun(sessionKey, runId);
  const finals = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final");
  assert.equal(finals.length, 1, "Exactly one chat final, not a second fallback/mirror final");
  assert.equal(finals[0], final);
  assert.equal(final.payload.message?.role, "assistant", "A status-only final is not assistant delivery");
  assert.equal(messageText(final.payload.message), expectedText, "The actual final frame must contain readable text");

  // Agent text and chat deltas are two projections of the same reply, not separate messages.
  const assistantFrames = frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "assistant");
  assert.ok(assistantFrames.length > 0, "The real Control UI client must receive global assistant events");
  let assistantText = "";
  for (const frame of assistantFrames) {
    assert.equal(typeof frame.payload.data.text, "string");
    const delta = frame.payload.data.delta ?? "";
    if (delta) assert.equal(frame.payload.data.text, assistantText + delta, "Incremental output must not repeat content");
    assistantText = frame.payload.data.text;
    assert.ok(expectedText.startsWith(frame.payload.data.text), "Agent snapshots must not duplicate/replace the answer");
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final), "No assistant output after final");
  }
  assert.equal(assistantText, expectedText, "A committed full snapshot is also valid assistant delivery");

  const deltas = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "delta");
  assert.ok(deltas.length > 0, "Persisted history must not substitute for a live chat delta");
  let delivered = "";
  for (const frame of deltas) {
    assert.equal(frame.payload.message?.role, "assistant");
    assert.equal(typeof frame.payload.deltaText, "string");
    delivered = frame.payload.replace ? frame.payload.deltaText : delivered + frame.payload.deltaText;
    assert.equal(messageText(frame.payload.message), delivered);
    assert.ok(expectedText.startsWith(delivered), "Chat stream must not duplicate/replace the answer");
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final), "No chat delta after final");
  }
  assert.equal(delivered, expectedText);
}

function assertCanonicalHistory(history, turns, redacted = false) {
  const assistants = history.messages.filter((message) => message.role === "assistant");
  assert.deepEqual(assistants.map(messageText), turns.map((turn) => turn.text),
    "Canonical history must contain exactly one native assistant per turn");
  assert.equal(history.messages.filter((message) => message.role === "user").length, turns.length);
  assistants.forEach((assistant, index) => {
    assert.equal(assistant.idempotencyKey ?? assistant.__openclaw?.idempotencyKey,
      `dsh-native:${turns[index].runId}:assistant`);
    assert.equal(assistant.provider, redacted ? "***" : "github-copilot");
    assert.equal(assistant.model, redacted ? "***" : "gpt-6-astra");
  });
}

test("Dashboard human chat.send delivers native tool results over real agent/chat events exactly once", { timeout: 620000 }, async () => {
  const gateway = await startDashboardGateway(async ({ body, reasoning, tool, text, finish }) => {
    if (body.input.some((item) => item.type === "function_call_output")) text("DASHBOARD-NATIVE-OK");
    else {
      reasoning("Synthetic fixture planning.");
      tool("read", { path: "fixture.txt" }, "dashboard_read");
    }
    finish();
  });
  const sessionKey = `agent:${gateway.agentId}:dashboard-delivery`;
  const runId = "dashboard-chat-send-run";
  try {
    await assertInheritedAgentPin(gateway);
    const response = await gateway.chat.request("chat.send", {
      sessionKey,
      agentId: gateway.agentId,
      message: "Read fixture.txt with the read tool, then reply DASHBOARD-NATIVE-OK.",
      thinking: "medium",
      idempotencyKey: runId,
    }, {
      timeoutMs: 120000,
    });
    assert.equal(response?.status, "started");
    assert.equal(response?.runId, runId);
    const final = await gateway.waitForFinal(sessionKey, runId);
    const settled = await gateway.waitForDurableSettle(sessionKey, runId);
    assertDeliveredOnce(gateway, sessionKey, runId, "DASHBOARD-NATIVE-OK", final);
    assertCanonicalHistory(settled.history, [{ runId, text: "DASHBOARD-NATIVE-OK" }]);
    assertNoFallback(gateway, sessionKey, runId, settled.history);
    assert.equal(gateway.responses.requests.length, 2);
    const [first, second] = gateway.responses.requests;
    assert.equal(first.headers.authorization, "Bearer dashboard-not-a-real-key");
    assert.equal(first.headers["copilot-integration-id"], "copilot-developer-cli");
    assert.equal(first.headers["x-initiator"], "user");
    assert.equal(second.headers["x-initiator"], "agent");
    assert.equal(first.body.model, "gpt-6-astra");
    assert.equal(first.body.store, false);
    assert.equal(first.body.reasoning.effort, "medium");
    assert.equal(first.body.input[0].role, "developer");
    assert.match(first.body.input[0].content, /DSH callback-only host/);
    const toolNames = first.body.tools.map((entry) => entry.name);
    assert.equal(toolNames.includes("read"), true);
    assert.equal(toolNames.length > 0, true);
    assert.equal(toolNames.every((name) => gateway.coreTools.includes(name)), true);
    assert.equal(first.body.tools.some((entry) => /task|message/i.test(entry.name)), false);
    assert.equal(second.body.input.some((item) =>
      item.type === "function_call_output" && JSON.stringify(item.output).includes("DASHBOARD-HOST-READ")), true);
    assert.equal(settled.bindings.length, 1);
    assert.equal(settled.binding.value.status, "ready");
    assert.equal(settled.binding.value.lastRunId, runId);
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});

test("Dashboard Agent pin keeps inherited model identity across redacted persistence and a second tool turn", { timeout: 620000 }, async () => {
  const firstText = "DASHBOARD-REDACTED-TURN-ONE";
  const secondText = "DASHBOARD-REDACTED-TOOL-TURN-TWO";
  const gateway = await startDashboardGateway(async ({ index, reasoning, tool, text, finish }) => {
    if (index === 0) text(firstText);
    else if (index === 1) {
      reasoning("Synthetic continuation planning.");
      tool("read", { path: "fixture.txt" }, "dashboard_continuation_read");
    } else if (index === 2) text(secondText);
    else throw new Error("Unexpected extra provider request: retry or fallback");
    finish();
  }, { redactTranscriptIdentity: true });
  try {
    await assertInheritedAgentPin(gateway);
    const sessionKey = `agent:${gateway.agentId}:dashboard-redacted-continuation`;
    const turns = [
      { runId: "dashboard-redacted-run-one", text: firstText, message: `Reply ${firstText} without tools.` },
      { runId: "dashboard-redacted-run-two", text: secondText,
        message: `Continue our conversation. Read fixture.txt with the read tool, then reply ${secondText}.` },
    ];
    let nativeSessionId;
    let hostSessionId;
    let bindingPath;
    let finalHistory;
    const finals = [];
    for (const [index, turn] of turns.entries()) {
      const response = await gateway.chat.request("chat.send", {
        sessionKey, agentId: gateway.agentId, message: turn.message,
        thinking: "medium", idempotencyKey: turn.runId,
      }, { timeoutMs: 120000 });
      assert.equal(response?.status, "started");
      assert.equal(response?.runId, turn.runId);
      const final = await gateway.waitForFinal(sessionKey, turn.runId);
      const settled = await gateway.waitForDurableSettle(sessionKey, turn.runId);
      finals.push(final);
      assert.equal(settled.assistant.provider, "***", "The real persistence redaction must remain active");
      assert.equal(settled.assistant.model, "***", "The real persistence redactor must redact model identity too");
      // Check B before A here so the two regressions have independent failure diagnostics.
      assertNoFallback(gateway, sessionKey, turn.runId, settled.history);
      assertCanonicalHistory(settled.history, turns.slice(0, index + 1), true);
      assertDeliveredOnce(gateway, sessionKey, turn.runId, turn.text, final);
      finalHistory = settled.history;
      assert.equal(settled.bindings.length, 1);
      assert.equal(settled.binding.value.lastRunId, turn.runId);
      assert.ok(settled.binding.value.sessionId);
      assert.ok(settled.history.sessionId);
      nativeSessionId ??= settled.binding.value.sessionId;
      hostSessionId ??= settled.history.sessionId;
      bindingPath ??= settled.binding.path;
      assert.equal(settled.binding.value.sessionId, nativeSessionId, "Second turn must resume native history");
      assert.equal(settled.history.sessionId, hostSessionId, "Second turn must keep the canonical host session");
      assert.equal(settled.binding.path, bindingPath);
      assert.equal(gateway.responses.requests.length, index === 0 ? 1 : 3);
    }
    // Recheck both runs after durable second-turn completion for late duplicates/cross-run output.
    turns.forEach((turn, index) => {
      assertNoFallback(gateway, sessionKey, turn.runId, finalHistory);
      assertDeliveredOnce(gateway, sessionKey, turn.runId, turn.text, finals[index]);
    });
    const [first, continuation, toolReply] = gateway.responses.requests;
    for (const request of [first, continuation, toolReply]) {
      assert.equal(request.headers.authorization, "Bearer dashboard-not-a-real-key");
      assert.equal(request.headers["copilot-integration-id"], "copilot-developer-cli");
      assert.equal(request.body.model, "gpt-6-astra", "Route must not use the redacted transcript model");
      assert.equal(request.body.store, false);
      assert.match(request.body.input[0].content, /DSH callback-only host/);
    }
    assert.equal(first.headers["x-initiator"], "user");
    assert.equal(continuation.headers["x-initiator"], "user");
    assert.equal(toolReply.headers["x-initiator"], "agent");
    const previousReplies = continuation.body.input.filter((item) => item.role === "assistant");
    assert.equal(previousReplies.filter((item) => JSON.stringify(item.content).includes(firstText)).length, 1,
      "The second native request must carry the first assistant exactly once");
    assert.ok(continuation.body.input.some((item) =>
      item.role === "user" && JSON.stringify(item.content).includes(turns[0].message)));
    assert.ok(continuation.body.input.some((item) =>
      item.role === "user" && JSON.stringify(item.content).includes(turns[1].message)));
    const outputs = toolReply.body.input.filter((item) =>
      item.type === "function_call_output" && item.call_id === "dashboard_continuation_read");
    assert.equal(outputs.length, 1);
    assert.match(JSON.stringify(outputs[0].output), /DASHBOARD-HOST-READ/);
    await gateway.assertHealthyLogs();
  } finally { await gateway.close(); }
});

test("stock-host model-scoped Dashboard selection still delivers one final answer", { timeout: 620000 }, async () => {
  const expected = "STOCK-HOST-DSH-FINAL";
  const gateway = await startDashboardGateway(async ({ text, finish }) => {
    text(expected);
    finish();
  }, { agentPinned: false });
  try {
    const sessionKey = `agent:${gateway.agentId}:stock-host-dashboard`;
    const runId = "stock-host-dashboard-run";
    await gateway.chat.request("chat.send", {
      sessionKey, agentId: gateway.agentId, message: `Reply ${expected} without tools.`,
      thinking: "medium", idempotencyKey: runId,
    }, { timeoutMs: 120000 });
    const final = await gateway.waitForFinal(sessionKey, runId);
    const settled = await gateway.waitForDurableSettle(sessionKey, runId);
    assertDeliveredOnce(gateway, sessionKey, runId, expected, final);
    assertCanonicalHistory(settled.history, [{ runId, text: expected }]);
    assertNoFallback(gateway, sessionKey, runId, settled.history);
    assert.equal(gateway.responses.requests.length, 1);
    await gateway.assertHealthyLogs();
  } finally { await gateway.close(); }
});
