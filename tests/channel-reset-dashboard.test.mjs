import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";
import { HOST_SEARCH_PROVIDER_ID, HOST_SEARCH_URL } from "./fixtures/host-search-plugin.mjs";

const TIMEOUT = 900000;
const HOST_TOOLS = ["web_search"];

function serialized(value) {
  return JSON.stringify(value);
}

function requestText(item) {
  if (typeof item?.content === "string") return item.content;
  return (item?.content ?? []).filter((block) => typeof block.text === "string").map((block) => block.text).join("");
}

function assertNoSecrets(value, gateway) {
  const body = serialized(value);
  for (const secret of Object.values(gateway.searchFixture.config)) {
    assert.equal(body.includes(secret), false, "Host provider credentials/details must not cross the model or final boundary");
  }
}

function assertNoFallback(gateway, sessionKey, runId, final, history) {
  const frames = gateway.eventsForRun(sessionKey, runId);
  assert.deepEqual(frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "lifecycle" &&
    ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), [], "No runtime fallback may deliver the turn");
  assert.equal(messageText(final.payload.message), final.payload.message.content[0].text,
    "The final frame must carry actual assistant text");
  for (const value of [final, history, ...frames]) {
    assertNoSecrets(value, gateway);
    assert.doesNotMatch(serialized(value), /model fallback|selected model unavailable/i);
  }
}

function assertSearchRequest(body, turn, forbiddenText) {
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "medium");
  assert.ok(body.tools.some((tool) => tool.name === "web_search"), "Core web_search must be model-visible");
  const users = body.input.filter((item) => item.role === "user").map(requestText);
  assert.ok(users.at(-1)?.includes(turn.prompt), "The admitted current user text must be sent");
  for (const forbidden of forbiddenText) {
    assert.equal(serialized(body).includes(forbidden), false,
      `Reset-native request must not send stale pre-boundary content: ${forbidden}`);
  }
}

function searchCall(query) {
  return { name: "web_search", args: { query, count: 1 }, callId: `search_${randomUUID()}` };
}

function readDurableEvents(gateway, sessionId) {
  const path = join(gateway.root, "state", "agents", gateway.agentId, "agent", "openclaw-agent.sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(sessionId).map((row) => JSON.parse(row.event_json));
  } finally {
    database.close();
  }
}

async function waitForNativeSettle(gateway, state, turn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const [history, bindings] = await Promise.all([
      gateway.chat.request("chat.history", {
        sessionKey: state.sessionKey,
        agentId: gateway.agentId,
        limit: 50,
      }, { timeoutMs: 15000 }),
      gateway.readDshBindings(),
    ]);
    const assistant = history.messages.find((message) =>
      message.role === "assistant" && messageText(message) === turn.answer);
    const binding = bindings.find((entry) =>
      entry.value.status === "ready" && entry.value.lastRunId === turn.runId);
    last = { history, bindings };
    if (assistant && binding && !history.inFlightRun) return { history, bindings, binding, assistant };
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for DSH durable settle: ${serialized(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function runTurn(gateway, state, turn, forbiddenText = []) {
  state.active = { ...turn, step: 0 };
  const start = gateway.responses.requests.length;
  const response = await gateway.chat.request("chat.send", {
    sessionKey: state.sessionKey,
    agentId: gateway.agentId,
    message: turn.prompt,
    thinking: "medium",
    idempotencyKey: turn.runId,
  }, { timeoutMs: 120000 });
  assert.equal(response?.status, "started");
  assert.equal(response?.runId, turn.runId);
  const final = await gateway.waitForFinal(state.sessionKey, turn.runId);
  assert.equal(messageText(final.payload.message), turn.answer,
    "The actual final frame must be the model answer, not a reset/status/fallback delivery");
  let settled;
  try {
    settled = await waitForNativeSettle(gateway, state, turn);
  } catch (error) {
    const [history, bindings] = await Promise.all([
      gateway.chat.request("chat.history", {
        sessionKey: state.sessionKey,
        agentId: gateway.agentId,
        limit: 50,
      }, { timeoutMs: 15000 }).catch((historyError) => ({ error: String(historyError) })),
      gateway.readDshBindings().catch((bindingsError) => ({ error: String(bindingsError) })),
    ]);
    throw new Error(`Native durable settle failed for ${turn.runId}: final=${messageText(final.payload.message)} ` +
      `history=${serialized(history)} bindings=${serialized(bindings)} ` +
      `requests=${serialized(gateway.responses.requests.slice(start).map((request) => request.body.input))}`,
    { cause: error });
  }
  const requests = gateway.responses.requests.slice(start);
  assert.equal(requests.length, turn.call ? 2 : 1, "No retry, fallback, or hidden provider round trip");
  assertSearchRequest(requests[0].body, turn, forbiddenText);
  assertNoSecrets(requests, gateway);
  assertNoFallback(gateway, state.sessionKey, turn.runId, final, settled.history);
  const assistantKey = settled.assistant.idempotencyKey ?? settled.assistant.__openclaw?.idempotencyKey;
  assert.match(assistantKey, new RegExp(`^dsh-native:(?:reset:[^:]+:)?${turn.runId}:assistant$`),
    "Assistant ownership must be DSH-native and scoped to the current reset epoch/run");
  assert.equal(settled.history.sessionId, state.hostSessionId ?? settled.history.sessionId);
  if (state.nativeSessionId && turn.expectNewNativeEpoch) {
    assert.notEqual(settled.binding.value.sessionId, state.nativeSessionId,
      "A clear reset must start a fresh native DSH history even when the host sessionId is retained");
    state.nativeSessionId = settled.binding.value.sessionId;
  } else {
    assert.equal(settled.binding.value.sessionId, state.nativeSessionId ?? settled.binding.value.sessionId);
  }
  state.hostSessionId ??= settled.history.sessionId;
  state.nativeSessionId ??= settled.binding.value.sessionId;
  state.active = undefined;
  return { final, settled, requests };
}

async function resetSameSession(gateway, state, reason = "new") {
  const before = await gateway.chat.request("chat.history", {
    sessionKey: state.sessionKey,
    agentId: gateway.agentId,
    limit: 50,
  }, { timeoutMs: 15000 });
  const beforeEvents = readDurableEvents(gateway, state.hostSessionId);
  const reset = await gateway.chat.request("sessions.reset", {
    key: state.sessionKey,
    agentId: gateway.agentId,
    reason,
  }, { timeoutMs: 120000 });
  assert.equal(reset?.ok, true);
  assert.equal(reset.key, state.sessionKey);
  assert.equal(reset.entry.sessionId, state.hostSessionId,
    "Gateway /new reset must retain the canonical persistent sessionId");
  const after = await gateway.chat.request("chat.history", {
    sessionKey: state.sessionKey,
    agentId: gateway.agentId,
    limit: 50,
  }, { timeoutMs: 15000 });
  const afterEvents = readDurableEvents(gateway, state.hostSessionId);
  assert.deepEqual(afterEvents.slice(0, beforeEvents.length), beforeEvents,
    "Host reset appends a context boundary without deleting or rewriting durable history");
  assert.ok(afterEvents.slice(beforeEvents.length).some((event) => event.type === "reset"));
  return { reset, before, after, afterEvents };
}

test("Dashboard sessions.reset /new keeps the same host id while dsh-native starts a fresh native epoch", { timeout: TIMEOUT }, async () => {
  const state = { sessionKey: `agent:dashboard-fixture:channel-reset-${randomUUID()}`, active: undefined };
  const gateway = await startDashboardGateway(async ({ body, tool, text, finish }) => {
    assert.ok(state.active, "No unsolicited model request or fallback");
    assertNoSecrets(body, gateway);
    const turn = state.active;
    if (turn.call && turn.step === 0) {
      assertSearchRequest(body, turn, turn.forbiddenText ?? []);
      tool(turn.call.name, turn.call.args, turn.call.callId);
    } else if (turn.call && turn.step === 1) {
      const output = body.input.find((item) => item.type === "function_call_output" && item.call_id === turn.call.callId);
      assert.ok(output, "Real core web_search result must be returned to the model");
      const result = JSON.parse(output.output);
      assert.equal(result.kind, "results");
      assert.equal(result.provider, HOST_SEARCH_PROVIDER_ID);
      assert.equal(result.results[0].url, HOST_SEARCH_URL);
      text(turn.answer);
    } else if (!turn.call && turn.step === 0) {
      text(turn.answer);
    } else {
      throw new Error("Unexpected extra provider request: retry or fallback");
    }
    turn.step += 1;
    finish();
  }, { searchFixture: true, hostTools: HOST_TOOLS });

  const preReset = {
    runId: `pre-reset-${randomUUID()}`,
    prompt: "Remember PRE-RESET-OLD-CONTENT and reply PRE-RESET-OLD-ANSWER without tools.",
    answer: "PRE-RESET-OLD-ANSWER",
  };
  const freshSearch = {
    runId: `fresh-search-${randomUUID()}`,
    prompt: "After /new, search the synthetic public reset reference and report the host result.",
    call: searchCall(`fresh reset query ${randomUUID()}`),
    answer: "FRESH-RESET-SEARCH-ANSWER",
    expectNewNativeEpoch: true,
  };
  const sameEpoch = {
    runId: `same-epoch-${randomUUID()}`,
    prompt: "Continue after the reset search and reply SAME-EPOCH-CONTINUITY.",
    answer: "SAME-EPOCH-CONTINUITY",
  };
  const secondFresh = {
    runId: `second-fresh-${randomUUID()}`,
    prompt: "After the second /new, search another synthetic reset reference.",
    call: searchCall(`second fresh reset query ${randomUUID()}`),
    answer: "SECOND-FRESH-SEARCH-ANSWER",
    expectNewNativeEpoch: true,
  };

  try {
    await runTurn(gateway, state, preReset);
    const firstHostSessionId = state.hostSessionId;
    const firstNativeSessionId = state.nativeSessionId;
    const foreign = await gateway.chat.request("chat.inject", {
      sessionKey: state.sessionKey, agentId: gateway.agentId,
      message: "FOREIGN-PRE-RESET-ASSISTANT", label: "reset fixture",
    }, { timeoutMs: 30000 });
    assert.equal(foreign.ok, true);

    const firstReset = await resetSameSession(gateway, state, "new");
    assert.ok(firstReset.before.messages.some((message) => messageText(message).includes("PRE-RESET-OLD-ANSWER")),
      "The pre-reset host transcript remains readable before the clear boundary is appended");
    assert.ok(firstReset.afterEvents.some((event) => messageText(event.message).includes("PRE-RESET-OLD-ANSWER")),
      "Clear reset must preserve earlier durable history even if chat.history defaults to current context");
    const foreignBefore = firstReset.before.messages.find((message) =>
      messageText(message).includes("FOREIGN-PRE-RESET-ASSISTANT"));
    assert.equal(foreignBefore?.role, "assistant");
    assert.equal(String(foreignBefore.idempotencyKey ?? "").startsWith("dsh-native:"), false);
    assert.ok(firstReset.afterEvents.some((event) => messageText(event.message).includes("FOREIGN-PRE-RESET-ASSISTANT")),
      "Foreign host messages remain durable but must not enter the new native epoch");
    assert.equal(firstReset.after.messages.some((message) => messageText(message).includes("✅ New session started.")), false,
      "Direct Gateway reset models the no-transcript-ack host clear path, not an acknowledgement whitelist");

    freshSearch.forbiddenText = ["PRE-RESET-OLD-CONTENT", "PRE-RESET-OLD-ANSWER", "FOREIGN-PRE-RESET-ASSISTANT"];
    const fresh = await runTurn(gateway, state, freshSearch, freshSearch.forbiddenText);
    assert.equal(state.hostSessionId, firstHostSessionId, "Host reset retains the same canonical session id");
    assert.notEqual(state.nativeSessionId, firstNativeSessionId, "A clear reset starts a fresh native DSH history");
    assert.equal((await gateway.searchFixture.readRecords()).filter((entry) =>
      entry.kind === "search-execute" && entry.args.query === freshSearch.call.args.query).length, 1,
    "The registered loopback web_search provider must execute exactly once after reset");

    const continuity = await runTurn(gateway, state, sameEpoch,
      ["PRE-RESET-OLD-CONTENT", "PRE-RESET-OLD-ANSWER", "FOREIGN-PRE-RESET-ASSISTANT"]);
    assert.equal(state.nativeSessionId, fresh.settled.binding.value.sessionId,
      "The next turn after reset must continue the same fresh native epoch");
    assert.ok(serialized(continuity.requests[0].body).includes(freshSearch.prompt));
    assert.ok(serialized(continuity.requests[0].body).includes(freshSearch.answer));

    await resetSameSession(gateway, state, "new");
    await runTurn(gateway, state, secondFresh, [
      "PRE-RESET-OLD-CONTENT", "PRE-RESET-OLD-ANSWER", "FOREIGN-PRE-RESET-ASSISTANT",
      freshSearch.prompt, freshSearch.answer, sameEpoch.prompt, sameEpoch.answer,
    ]);
    assert.equal(state.hostSessionId, firstHostSessionId);
    assert.notEqual(state.nativeSessionId, fresh.settled.binding.value.sessionId,
      "A repeated /new with the same host id must create another fresh native epoch");
    assert.equal((await gateway.searchFixture.readRecords()).filter((entry) =>
      entry.kind === "search-execute" && entry.args.query === secondFresh.call.args.query).length, 1);
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});
