import assert from "node:assert/strict";
import test from "node:test";
import { startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

test("Dashboard chat.send accepts gateway task suggestions and runs native DSH over Responses", { timeout: 620000 }, async () => {
  const gateway = await startDashboardGateway(async ({ body, reasoning, tool, text, finish }) => {
    if (body.input.some((item) => item.type === "function_call_output")) text("DASHBOARD-NATIVE-OK");
    else {
      reasoning();
      tool("read", { path: "fixture.txt" }, "dashboard_read");
    }
    finish();
  });
  const sessionKey = "agent:experiment:dashboard-compat";
  const runId = "dashboard-chat-send-run";
  try {
    const response = await gateway.chat.request("chat.send", {
      sessionKey,
      agentId: "experiment",
      message: "Read fixture.txt with the read tool, then reply DASHBOARD-NATIVE-OK.",
      thinking: "medium",
      idempotencyKey: runId,
    }, {
      expectFinal: true,
      timeoutMs: 120000,
    });
    assert.equal(response?.status, "started");
    assert.equal(response?.runId, runId);
    const assistant = await gateway.waitForAssistant(sessionKey, "DASHBOARD-NATIVE-OK");
    assert.match(JSON.stringify(assistant), /DASHBOARD-NATIVE-OK/);
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
    const bindings = await gateway.readDshBindings();
    assert.equal(bindings.length > 0, true);
    assert.equal(bindings[0].value.status, "ready");
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});

test("Dashboard chat.send uses an Agent pin with an inherited model and no model-specific runtime entry", { timeout: 620000 }, async () => {
  const gateway = await startDashboardGateway(async ({ text, finish }) => {
    text("DASHBOARD-AGENT-PIN-OK");
    finish();
  }, { agentPinned: true });
  try {
    const sessionKey = "agent:experiment:dashboard-agent-pin";
    await gateway.chat.request("chat.send", {
      sessionKey, agentId: "experiment",
      message: "Reply DASHBOARD-AGENT-PIN-OK without using tools.",
      thinking: "medium", idempotencyKey: "dashboard-agent-pin-run",
    }, { timeoutMs: 120000 });
    await gateway.waitForAssistant(sessionKey, "DASHBOARD-AGENT-PIN-OK");
    assert.equal(gateway.responses.requests.length, 1);
    assert.equal(gateway.responses.requests[0].body.model, "gpt-6-astra");
    assert.match(gateway.responses.requests[0].body.input[0].content, /DSH callback-only host/);
    const bindings = await gateway.readDshBindings();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].value.status, "ready");
  } finally { await gateway.close(); }
});
