import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";
import { SOURCE_REPLY_ACCOUNT_ID } from "./fixtures/source-reply-channel.mjs";

const timeout = 600000;
async function dispatch(gateway, prompt) {
  const sessionKey = `agent:${gateway.agentId}:source-reply-${randomUUID()}`;
  const response = await gateway.chat.request("sourceReplyFixture.dispatch", {
    agentId: gateway.agentId, sessionKey, messageId: `inbound-${randomUUID()}`, text: prompt,
  }, { timeoutMs: 180000 });
  const history = await gateway.chat.request("chat.history", {
    agentId: gateway.agentId, sessionKey, limit: 20,
  }, { timeoutMs: 30000 });
  const records = await gateway.sourceReply.readRecords();
  return { response, history, records, sessionKey, diagnostics: JSON.stringify({
    response, records, events: gateway.events.filter((frame) => frame.payload?.sessionKey === sessionKey),
    log: (await readFile(gateway.logPath, "utf8")).slice(-20000),
  }) };
}

function assertNativeOutcome(records, terminal, delivered, diagnostics) {
  const attempts = records.filter((entry) => entry.kind === "native-attempt");
  const results = records.filter((entry) => entry.kind === "native-result");
  assert.equal(attempts.length, 1, diagnostics);
  assert.equal(results.length, 1, diagnostics);
  assert.equal(attempts[0].sourceReplyDeliveryMode, "message_tool_only");
  assert.equal(results[0].runId, attempts[0].runId);
  assert.equal(results[0].terminal, terminal, diagnostics);
  assert.equal(results[0].didSendViaMessagingTool, delivered, diagnostics);
  assert.equal(results[0].sourceReplyDelivered === true, delivered, diagnostics);
  return attempts[0].runId;
}

for (const redact of [false, true]) {
test(`source-only channel privately delivers the ${redact ? "redacted" : "committed"} final exactly once`, { timeout }, async () => {
  const answer = redact ? "SAFE-PREFIX REDACT-ME SAFE-SUFFIX" : "VERIFIED-PRIVATE-SOURCE-REPLY";
  const gateway = await startDashboardGateway(({ body, text, finish }) => {
    assert.deepEqual(body.tools ?? [], []);
    text(answer);
    finish();
  }, { sourceReplyFixture: {}, hostTools: [], redactTranscriptPatterns: redact ? ["REDACT-ME"] : [] });
  try {
    const { response, history, records, sessionKey, diagnostics } = await dispatch(gateway, "Reply with the synthetic test answer. Do not perform business actions.");
    assert.equal(response.result.dispatched, true);
    const runId = assertNativeOutcome(records, "ok", true, diagnostics);
    const settled = await gateway.waitForDurableSettle(sessionKey, runId);
    const canonical = messageText(settled.assistant);
    assert.ok(!history.inFlightRun);
    if (redact) {
      assert.doesNotMatch(canonical, /REDACT-ME/);
      assert.match(canonical, /SAFE-PREFIX.*SAFE-SUFFIX/);
    } else assert.equal(canonical, answer);
    const sends = records.filter((entry) => entry.kind === "send-settled");
    assert.equal(sends.length, 1, diagnostics);
    assert.equal(sends[0].text, canonical);
    assert.equal(sends[0].accountId, SOURCE_REPLY_ACCOUNT_ID);
    assert.ok(["chat:source-reply-chat", "source-reply-chat"].includes(sends[0].to));
    const hooks = records.filter((entry) => entry.kind === "before-message");
    assert.equal(hooks.length, 1, JSON.stringify(records));
    assert.deepEqual(hooks[0].args, { action: "send", message: canonical, final: true });
    assert.equal(gateway.responses.requests.length, 1);
    const bindings = await gateway.readDshBindings();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].value.status, "ready");
    assert.equal(bindings[0].value.lastRunId, runId);
    assert.equal((await gateway.sourceReply.readRecords()).filter((entry) => entry.kind === "send-settled").length, 1);
    await gateway.assertHealthyLogs();
  } finally { await gateway.close(); }
});
}

test("source-only channel keeps a token-only silent completion off the transport", { timeout }, async () => {
  const gateway = await startDashboardGateway(({ body, text, finish }) => {
    assert.deepEqual(body.tools ?? [], []);
    text("NO_REPLY");
    finish();
  }, { sourceReplyFixture: {}, hostTools: [] });
  try {
    const { records, diagnostics } = await dispatch(gateway, "Complete silently.");
    assertNativeOutcome(records, "ok", false, diagnostics);
    assert.equal(records.filter((entry) => entry.kind === "send-attempt").length, 0, diagnostics);
    assert.equal(gateway.responses.requests.length, 1);
  } finally { await gateway.close(); }
});

for (const settings of [{ failSend: true }, { redirectHook: true }, { rewriteAction: true }]) {
  test(`source-only reply ${settings.failSend ? "transport failure" : settings.rewriteAction ? "action rewrite" : "hook redirection"} cannot claim delivery or send an automatic duplicate`,
    { timeout }, async () => {
      const gateway = await startDashboardGateway(({ body, text, finish }) => {
        assert.deepEqual(body.tools ?? [], []);
        text("NOT-DELIVERED-PRIVATE-FINAL");
        finish();
      }, { sourceReplyFixture: settings, hostTools: [] });
      try {
        const { records, diagnostics } = await dispatch(gateway, "Answer with NOT-DELIVERED-PRIVATE-FINAL.");
        assertNativeOutcome(records, "failed", false, diagnostics);
        assert.equal(records.filter((entry) => entry.kind === "before-message").length, 1, diagnostics);
        assert.equal(records.filter((entry) => entry.kind === "send-settled").length, 0, JSON.stringify(records));
        if (settings.failSend) assert.equal(records.filter((entry) => entry.kind === "send-failed").length, 1);
        else assert.equal(records.filter((entry) => entry.kind === "send-attempt").length, 0);
        assert.equal(gateway.responses.requests.length, 1, "A failed source reply must not replay native inference");
      } finally { await gateway.close(); }
    });
}
