import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";
import { createGatewayAcceptanceAdapter } from "../scripts/lib/gateway-acceptance-adapter.mjs";

test("acceptance adapter observes real Gateway frames, canonical records and DSH native usage across a reset", { timeout: 600000 }, async () => {
  const gateway = await startDashboardGateway(({ body, text, tool, finish }) => {
    assert.ok((body.tools ?? []).every((entry) => ["read", "dsh_prepare_task"].includes(entry.name)),
      "Dedicated read-only Agent cannot expose mutation or execution tools");
    const control = body.tools?.find((entry) => entry.name === "dsh_prepare_task");
    if (control) tool(control.name, {
      version: 1, revision: control.parameters.properties.revision.const, mode: "chat", task: "none",
      goal: "", deliverables: [], constraints: [], assumptions: [], unresolved: [],
      question: "", enhancedPrompt: "", evidence: { source: "current", quote: "" },
    });
    else text("ACCEPTANCE-REAL-SDK");
    finish();
  }, {
    agentId: "dsh-acceptance-fixture", agentToolPolicy: { allow: ["read"], fs: { workspaceOnly: true } },
    taskPreparation: { agentIds: ["dsh-acceptance-fixture"], skillAllowlist: [] }, hostTools: ["read"],
  });
  const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
  const adapter = await createGatewayAcceptanceAdapter({
    config: { hostRoot: join(gateway.root, "openclaw"), configPath: gateway.configPath,
      stateDir: join(gateway.root, "state"), nativeStateDir: gateway.dshState,
      gatewayUrl: `ws://127.0.0.1:${gateway.port}`, agentMap: { scout: gateway.agentId },
      allowedAgentIds: [gateway.agentId], ownedSessionPrefix: "acceptance-genuine", isolation: "agent-policy-read-only" },
    events: gateway.events,
    connectionFactory: async () => ({
      client: gateway.chat, assertHealthy() {}, hostConfig: config,
      readTranscript({ sessionId }) {
        const database = new DatabaseSync(join(gateway.root, "state", "agents", gateway.agentId, "agent", "openclaw-agent.sqlite"), { readOnly: true });
        try {
          return database.prepare("SELECT event_json FROM transcript_events WHERE session_id=? ORDER BY seq")
            .all(sessionId).map((row) => JSON.parse(row.event_json));
        } finally { database.close(); }
      },
    }),
  });
  const task = { id: "genuine-script", agentProfile: "scout", category: "business",
    prompt: "Return the test marker", turns: ["Return ACCEPTANCE-REAL-SDK", "Return ACCEPTANCE-REAL-SDK again"],
    adapterControls: [{ type: "new_context", appliesAfterTurn: 1, visibleToModel: false }],
    limits: { timeoutMs: 180000 } };
  const context = { runId: "genuine-acceptance", runDir: join(gateway.root, "acceptance-receipts"),
    signal: new AbortController().signal, reportUsage() {} };
  try {
    const result = await adapter.executeCase(task, context);
    assert.equal(result.turns.length, 2);
    assert.equal(result.controlReceipts.length, 1);
    assert.equal(result.controlReceipts[0].transportControlled, true);
    assert.equal(result.turns[0].sessionId, result.turns[1].sessionId);
    assert.notEqual(result.turns[0].nativeSessionId, result.turns[1].nativeSessionId);
    assert.equal(result.usage.modelRequests, gateway.responses.requests.length);
    assert.equal((await adapter.cleanupCase(task, context)).cleaned, true);
  } finally { await gateway.close(); }
});
