import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

test("eight billed model steps do not inflate the final call's context occupancy", { timeout: 900000 }, async () => {
  const totals = [17232, 18452, 18815, 19245, 21074, 21722, 22062, 22547];
  const gateway = await startDashboardGateway(async ({ index, body, tool, text, finish }) => {
    assert.ok(index < totals.length, "No automatic model retry or compaction is expected");
    assert.equal(body.model, "gpt-6-astra");
    if (index < totals.length - 1) tool("read", { path: "fixture.txt" }, `usage_read_${index}`);
    else text("CONTEXT-USAGE-CORRECT");
    const output = index === totals.length - 1 ? 146 : 8;
    finish({
      input_tokens: totals[index] - output,
      output_tokens: output,
      total_tokens: totals[index],
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  }, { hostTools: ["read"] });
  const sessionKey = `agent:${gateway.agentId}:context-usage-${randomUUID()}`;
  const runId = randomUUID();
  try {
    await gateway.chat.request("chat.send", { sessionKey, agentId: gateway.agentId,
      message: "Read the synthetic fixture as needed, then confirm the accounting probe.", idempotencyKey: runId,
      thinking: "medium" }, { timeoutMs: 120000 });
    const final = await gateway.waitForFinal(sessionKey, runId);
    const { history, assistant } = await gateway.waitForDurableSettle(sessionKey, runId);
    assert.equal(messageText(final.payload.message), "CONTEXT-USAGE-CORRECT");
    assert.equal(gateway.responses.requests.length, 8);
    assert.equal(assistant.usage.totalTokens, 161149, "Billing must retain all model steps");
    const database = new DatabaseSync(join(gateway.root, "state", "agents", gateway.agentId, "agent", "openclaw-agent.sqlite"),
      { readOnly: true });
    let canonical;
    try {
      canonical = database.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(history.sessionId).map((row) => JSON.parse(row.event_json))
        .findLast((event) => event.type === "message" && event.message.role === "assistant").message;
    } finally { database.close(); }
    assert.deepEqual(canonical.usage.contextUsage, { state: "available", promptTokens: 22401, totalTokens: 22547 },
      "Only the final request/response footprint describes current model context");
    assert.equal(canonical.usage.totalTokens, 161149);
    assert.equal(history.sessionId.length > 0, true);
    assert.equal(gateway.eventsForRun(sessionKey, runId).filter((frame) =>
      frame.event === "agent" && frame.payload.stream === "lifecycle" &&
      ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)).length, 0);
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});
