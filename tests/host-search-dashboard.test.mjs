import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";
import {
  HOST_SEARCH_MANIFEST, HOST_SEARCH_PLUGIN_ID, HOST_SEARCH_PROVIDER_ID, HOST_SEARCH_URL, LOOKUP_TOOL,
} from "./fixtures/host-search-plugin.mjs";

const CONTROL = "dsh_prepare_task";
const PROBE_TOOLS = ["read", "web_search", LOOKUP_TOOL];
const MISSING_TOOL = "fixture_missing";
const TIMEOUT = 900000;
const PREPARATION = { skillAllowlist: [], maxClarificationTurns: 3, maxToolCalls: 8 };

function systemText(body) {
  return body.input.filter((item) => ["system", "developer"].includes(item.role)).map(messageText).join("\n");
}

function requestText(item) {
  if (typeof item?.content === "string") return item.content;
  return (item?.content ?? []).filter((block) => typeof block.text === "string").map((block) => block.text).join("");
}

function assertToolNames(body, expected) {
  const names = (body.tools ?? []).map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "No duplicate/shadow web_search definitions");
  assert.deepEqual([...names].sort(), [...expected].sort(),
    "Only the exact DSH ceiling intersected with host policy is model-visible; no nested tool routers");
}

function assertCoreSearchSchema(body) {
  const search = body.tools.find((tool) => tool.name === "web_search");
  assert.ok(search);
  assert.equal(search.parameters.type, "object");
  assert.deepEqual(search.parameters.required, ["query"]);
  assert.equal(search.parameters.properties.query.type, "string");
  assert.equal(search.parameters.properties.count.minimum, 1);
  assert.equal(search.parameters.properties.count.maximum, 10);
  assert.equal(search.parameters.properties.domain_filter.type, "array",
    "2026.9.2 core dispatcher schema, not the narrower synthetic provider schema");
  assert.equal(search.parameters.properties.q, undefined);
  assert.match(search.description, /normalized provider results/i);
}

function assertUnavailable(body, name) {
  const notices = systemText(body).split(/\n\s*\n/);
  assert.ok(notices.some((notice) => notice.includes(name) &&
    /unavailable|missing|denied|not (?:available|materialized)/i.test(notice)),
  `System instructions must identify the requested but unavailable tool ${name}`);
  assert.equal((body.tools ?? []).some((tool) => tool.name === name), false);
}

function assertNoSecrets(value, gateway) {
  const serialized = JSON.stringify(value);
  for (const secret of Object.values(gateway.searchFixture.config)) {
    assert.equal(serialized.includes(secret), false, "Fixture host credentials/details must not cross the model boundary");
  }
}

function outputFor(body, callId) {
  const outputs = body.input.filter((item) => item.type === "function_call_output" && item.call_id === callId);
  assert.equal(outputs.length, 1, `Exactly one host/control result for ${callId}`);
  assert.equal(typeof outputs[0].output, "string");
  return outputs[0].output;
}

function preparationDecision(turn) {
  return {
    version: 1, revision: 0, mode: turn.mode, task: "new",
    goal: turn.message, deliverables: ["A text reply in this conversation"],
    constraints: ["Use only the supplied tools; never invent an unavailable result."],
    assumptions: [], unresolved: [], question: "",
    enhancedPrompt: turn.message,
    evidence: { source: "current", quote: turn.message },
  };
}

async function assertToolOutput(gateway, body, call) {
  const output = outputFor(body, call.callId);
  assertNoSecrets(output, gateway);
  const records = await gateway.searchFixture.readRecords();
  if (call.name === "read") {
    assert.match(output, /DASHBOARD-HOST-READ/);
    return "DASHBOARD-HOST-READ";
  }
  if (call.name === "web_search") {
    const executions = records.filter((entry) => entry.kind === "search-execute" && entry.args.query === call.args.query);
    assert.equal(executions.length, 1, "The registered host provider must actually execute exactly once");
    const execution = executions[0];
    assert.deepEqual(execution.args, call.args);
    assert.equal(execution.agentDir, gateway.agentDir);
    assert.equal(execution.credentialAvailable, true);
    assert.equal(execution.signalAvailable, true);
    assert.notEqual(execution.pid, process.pid, "The provider runs in the real Gateway, not the Responses test process");
    const result = JSON.parse(output);
    assert.equal(result.kind, "results");
    assert.equal(result.provider, HOST_SEARCH_PROVIDER_ID);
    assert.equal(result.query, call.args.query);
    assert.equal(result.count, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, HOST_SEARCH_URL);
    assert.ok(result.results[0].snippet.includes(execution.answer));
    assert.notEqual(result.results[0].snippet, execution.answer, "Core wraps provider prose as untrusted web content");
    assert.deepEqual(result.externalContent, {
      untrusted: true, source: "web_search", wrapped: true, provider: HOST_SEARCH_PROVIDER_ID,
    }, "The provider returns only raw results; this stamp must come from the real core dispatcher");
    return execution.answer;
  }
  assert.equal(call.name, LOOKUP_TOOL);
  const executions = records.filter((entry) => entry.kind === "lookup-execute" && entry.callId === call.callId);
  assert.equal(executions.length, 1);
  const execution = executions[0];
  assert.deepEqual(execution.args, call.args);
  assert.equal(execution.credentialAvailable, true);
  assert.equal(execution.signalAvailable, true);
  assert.notEqual(execution.pid, process.pid);
  // SDK descriptor-cache dispatch owns metadata on its wrapper, not necessarily on the factory's raw object.
  if (execution.metadata) {
    assert.equal(execution.metadata.pluginId, HOST_SEARCH_PLUGIN_ID);
    assert.equal(execution.metadata.optional, false);
    assert.equal(execution.metadata.replaySafe, true);
    assert.equal(execution.metadata.sideEffecting, false);
  }
  assert.equal(output, execution.answer, "Only content text, never tool.details, is serialized for DSH");
  const after = records.filter((entry) => entry.kind === "after_tool_call" && entry.callId === call.callId);
  assert.equal(after.length, 1);
  assert.equal(after[0].sawPrivateDetails, true, "Trusted host hooks still receive the unprojected result");
  return execution.answer;
}

function assertDelivery(gateway, turn, final, settled) {
  const frames = gateway.eventsForRun(turn.sessionKey, turn.runId);
  const finals = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final");
  assert.deepEqual(finals, [final]);
  assert.equal(final.payload.message?.role, "assistant");
  assert.equal(messageText(final.payload.message), turn.answer, "Assert the actual client final, not just persisted history");
  const deltas = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "delta");
  assert.ok(deltas.length > 0);
  let streamed = "";
  for (const frame of deltas) {
    assert.equal(typeof frame.payload.deltaText, "string");
    streamed = frame.payload.replace ? frame.payload.deltaText : streamed + frame.payload.deltaText;
    assert.equal(messageText(frame.payload.message), streamed);
    assert.ok(turn.answer.startsWith(streamed));
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final));
  }
  assert.equal(streamed, turn.answer);
  const assistantFrames = frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "assistant");
  assert.ok(assistantFrames.length > 0);
  assert.equal(assistantFrames.at(-1).payload.data.text, turn.answer);
  assert.deepEqual(frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "lifecycle" &&
    ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), []);
  const history = settled.history;
  assert.deepEqual(history.messages.filter((message) => message.role === "user").map(messageText), [turn.message]);
  assert.deepEqual(history.messages.filter((message) => message.role === "assistant").map(messageText), [turn.answer]);
  assert.equal(settled.assistant.idempotencyKey ?? settled.assistant.__openclaw?.idempotencyKey,
    `dsh-native:${turn.runId}:assistant`);
  assert.equal(settled.assistant.provider, "github-copilot");
  assert.equal(settled.assistant.model, "gpt-6-astra");
  assert.equal(history.sessionInfo.modelProvider, "github-copilot");
  assert.equal(history.sessionInfo.model, "gpt-6-astra");
  assert.equal(history.sessionInfo.activeModelProvider, undefined);
  assert.equal(history.sessionInfo.activeModel, undefined);
  assert.equal(settled.binding.value.status, "ready");
  assert.equal(settled.binding.value.lastRunId, turn.runId);
  assertNoSecrets(history, gateway);
  for (const frame of frames) {
    if (frame.event === "chat" || frame.event === "agent" && ["assistant", "reasoning"].includes(frame.payload.stream)) {
      assertNoSecrets(frame.payload, gateway);
      assert.equal(JSON.stringify(frame.payload).includes(turn.plannerMarker), false);
      assert.doesNotMatch(messageText(frame.payload.message), /model fallback|selected model unavailable/i);
    }
  }
}

async function assertHostLifecycle(gateway, turn, settled, beforeRecords) {
  const records = (await gateway.searchFixture.readRecords()).slice(beforeRecords);
  const tracedCalls = turn.calls.filter((call) => ["web_search", LOOKUP_TOOL].includes(call.name));
  const expectedSearches = tracedCalls.filter((call) => call.name === "web_search");
  assert.equal(records.filter((entry) => entry.kind === "search-execute").length, expectedSearches.length);
  assert.equal(records.filter((entry) => entry.kind === "search-create").length, expectedSearches.length,
    "Core calls the registered provider's createTool lazily during dispatch");
  assert.equal(records.filter((entry) => entry.kind === "lookup-execute").length,
    tracedCalls.filter((call) => call.name === LOOKUP_TOOL).length);
  for (const phase of ["before_tool_call", "after_tool_call"]) {
    const hooks = records.filter((entry) => entry.kind === phase);
    assert.deepEqual(hooks.map((entry) => entry.callId), tracedCalls.map((call) => call.callId));
    for (const [index, hook] of hooks.entries()) {
      const call = tracedCalls[index];
      assert.equal(hook.toolName, call.name);
      assert.deepEqual(hook.args, call.args);
      assert.equal(hook.agentId, gateway.agentId);
      assert.equal(hook.sessionKey, turn.sessionKey);
      assert.equal(hook.sessionId, settled.history.sessionId);
      assert.equal(hook.runId, turn.runId);
      if (phase === "after_tool_call") assert.equal(hook.failed, false);
    }
  }
  for (const execution of records.filter((entry) => entry.kind === "lookup-execute")) {
    assert.equal(execution.agentId, gateway.agentId);
    assert.equal(execution.sessionKey, turn.sessionKey);
    assert.equal(execution.sessionId, settled.history.sessionId);
    assert.equal(execution.workspaceDir, gateway.workspace);
    assert.equal(execution.agentDir, gateway.agentDir);
  }
  if (turn.calls.length === 0) {
    assert.deepEqual(gateway.eventsForRun(turn.sessionKey, turn.runId).filter((frame) =>
      frame.event === "agent" && frame.payload.stream === "tool"), [], "No host calls for unavailable-tool drafting");
  }
}

async function startScenario(options) {
  let active;
  let gateway;
  const adaptive = !!options.taskPreparation;
  gateway = await startDashboardGateway(async ({ body, tool, text, finish }) => {
    assert.ok(active, "No unsolicited provider request or fallback");
    const turn = active;
    const step = turn.step++;
    assertNoSecrets(body, gateway);
    assert.equal(body.model, "gpt-6-astra");
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "medium");
    assert.equal(body.input[0].role, "developer");
    assert.match(systemText(body), /DSH callback-only host/);
    const users = body.input.filter((item) => item.role === "user");
    assert.ok(requestText(users.at(-1)).includes(turn.message));
    if (turn.originalUsers) assert.deepEqual(users, turn.originalUsers, "Preparation cannot replace the real admission text");
    else turn.originalUsers = users;
    for (const name of turn.unavailable) assertUnavailable(body, name);
    if (adaptive && step === 0) {
      assertToolNames(body, [CONTROL]);
      const control = body.tools[0];
      assert.equal(control.parameters.properties.revision.const, 0);
      const start = control.description.indexOf("\n{");
      assert.notEqual(start, -1);
      const request = JSON.parse(control.description.slice(start + 1));
      assert.equal(request.userText, turn.message);
      assert.equal(request.previous, undefined, "Each probe uses a fresh native session");
      assert.deepEqual(request.policy.executionTools, options.hostTools,
        "Top-level toolAllowlist is inherited when taskPreparation.executionTools is omitted");
      text(turn.plannerMarker);
      tool(CONTROL, turn.decision, turn.controlId);
      finish();
      return;
    }
    const callIndex = step - (adaptive ? 1 : 0);
    assert.ok(callIndex <= turn.calls.length, "No retry or unexpected provider step");
    const expectedTools = adaptive && turn.mode !== "execute" ? [] : turn.expectedTools;
    assertToolNames(body, expectedTools);
    if (expectedTools.includes("web_search")) assertCoreSearchSchema(body);
    if (adaptive) {
      const resolution = JSON.parse(outputFor(body, turn.controlId));
      assert.deepEqual(resolution.decision, turn.decision);
      assert.deepEqual([...resolution.allowedTools].sort(), [...expectedTools].sort());
      assert.equal(resolution.state.sourceRunId, turn.runId);
      assert.equal(resolution.state.requestText, turn.message);
      assert.equal(resolution.state.revision, 1);
      if (turn.resolution) assert.deepEqual(resolution, turn.resolution);
      turn.resolution = resolution;
    }
    if (callIndex > 0) turn.answers.push(await assertToolOutput(gateway, body, turn.calls[callIndex - 1]));
    const call = turn.calls[callIndex];
    if (call) {
      assert.ok(expectedTools.includes(call.name));
      tool(call.name, call.args, call.callId);
    } else {
      turn.answer ??= `Verified host results: ${turn.answers.join("; ")}.`;
      text(turn.answer);
    }
    finish();
  }, { ...options, searchFixture: true });
  return {
    gateway,
    async run({ name, message, calls = [], expectedTools, unavailable = [], mode = "execute", answer }) {
      const runId = `host-search-${randomUUID()}`;
      const turn = {
        sessionKey: `agent:${gateway.agentId}:${name}-${randomUUID()}`, runId, message,
        expectedTools, unavailable, mode, answer, answers: [], step: 0,
        controlId: `${runId}_prepare`, plannerMarker: `PRIVATE-HOST-PREPARATION-${runId}`,
        calls: calls.map((call, index) => ({ ...call, callId: `${runId}_host_${index}` })),
      };
      turn.decision = preparationDecision(turn);
      const beforeRecords = (await gateway.searchFixture.readRecords()).length;
      const requestStart = gateway.responses.requests.length;
      active = turn;
      const response = await gateway.chat.request("chat.send", {
        sessionKey: turn.sessionKey, agentId: gateway.agentId, message,
        thinking: "medium", idempotencyKey: runId,
      }, { timeoutMs: 120000 });
      assert.equal(response?.status, "started");
      assert.equal(response?.runId, runId);
      const final = await gateway.waitForFinal(turn.sessionKey, runId);
      const settled = await gateway.waitForDurableSettle(turn.sessionKey, runId);
      const requests = gateway.responses.requests.slice(requestStart);
      assert.equal(requests.length, calls.length + (adaptive ? 2 : 1));
      requests.forEach((request, index) => {
        assertNoSecrets(request, gateway);
        assert.equal(request.headers.authorization, "Bearer dashboard-not-a-real-key");
        assert.equal(request.headers["copilot-integration-id"], "copilot-developer-cli");
        assert.equal(request.headers["x-initiator"], index === 0 ? "user" : "agent",
          "Human dashboard admission remains a normal user request, not synthetic worker authority");
      });
      const outputs = requests.at(-1).body.input.filter((item) => item.type === "function_call_output");
      assert.deepEqual(outputs.map((item) => item.call_id), [
        ...(adaptive ? [turn.controlId] : []), ...turn.calls.map((call) => call.callId),
      ]);
      assertDelivery(gateway, turn, final, settled);
      await assertHostLifecycle(gateway, turn, settled, beforeRecords);
      if (adaptive) assert.deepEqual(settled.binding.value.taskPreparation.state, turn.resolution.state);
      await gateway.assertHealthyLogs();
      active = undefined;
      return { turn, settled, requests };
    },
  };
}

async function assertFixtureConfig(gateway, hostTools) {
  const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
  assert.equal(config.agents.defaults.model.primary, gateway.modelRef);
  assert.deepEqual(config.agents.entries[gateway.agentId].runtime, { type: "embedded", harness: "dsh-native" });
  assert.equal(config.agents.entries[gateway.agentId].model, undefined);
  assert.equal(config.agents.entries[gateway.agentId].models, undefined);
  assert.equal(config.agents.defaults.models, undefined);
  assert.equal(config.tools.profile, "coding");
  assert.deepEqual(config.tools.web.search, { enabled: true, provider: HOST_SEARCH_PROVIDER_ID });
  assert.deepEqual(config.plugins.allow, ["dsh-native", HOST_SEARCH_PLUGIN_ID]);
  assert.deepEqual(config.plugins.entries["dsh-native"].config.toolAllowlist, hostTools);
  const preparation = config.plugins.entries["dsh-native"].config.taskPreparation;
  if (preparation) {
    assert.deepEqual(preparation.agentIds, [gateway.agentId]);
    assert.equal(Object.hasOwn(preparation, "executionTools"), false);
  }
  assert.deepEqual(HOST_SEARCH_MANIFEST.contracts.tools, [LOOKUP_TOOL],
    "The fixture never registers a tool named web_search; only OpenClaw owns that name");
  const manifest = JSON.parse(await readFile(join(gateway.searchFixture.plugin, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.id, HOST_SEARCH_PLUGIN_ID);
  assert.deepEqual(manifest.contracts, { webSearchProviders: [HOST_SEARCH_PROVIDER_ID], tools: [LOOKUP_TOOL] });
  assert.deepEqual(manifest.toolMetadata[LOOKUP_TOOL],
    { profiles: ["coding"], replaySafe: true, sideEffecting: false });
  const records = await gateway.searchFixture.readRecords();
  assert.ok(records.some((entry) => entry.kind === "registered" && entry.pluginId === HOST_SEARCH_PLUGIN_ID &&
    entry.providerId === HOST_SEARCH_PROVIDER_ID && entry.pid !== process.pid));
}

function searchCall() {
  return { name: "web_search", args: { query: `synthetic public reference ${randomUUID()}`, count: 1 } };
}

function lookupCall() {
  return { name: LOOKUP_TOOL, args: { key: `fixture-record-${randomUUID()}` } };
}

test("Dashboard non-adaptive host bridge dispatches real core web_search and ordinary plugin tools", { timeout: TIMEOUT }, async (t) => {
  const scenario = await startScenario({ hostTools: PROBE_TOOLS });
  const { gateway } = scenario;
  try {
    await assertFixtureConfig(gateway, PROBE_TOOLS);
    await t.test("core provider registry and normalizer execute with host-only credentials", async () => {
      await scenario.run({
        name: "direct-search", message: "Search the synthetic public reference and report the actual host result.",
        expectedTools: PROBE_TOOLS, calls: [searchCall()],
      });
    });
    await t.test("standard registerTool retains ownership, context, and private result details", async () => {
      await scenario.run({
        name: "direct-lookup", message: "Look up the synthetic fixture record and report its actual value.",
        expectedTools: PROBE_TOOLS, calls: [lookupCall()],
      });
    });
  } finally { await gateway.close(); }
});

test("Dashboard adaptive preparation uses the top-level generic ceiling and honestly drafts when a tool is missing", { timeout: TIMEOUT }, async (t) => {
  const hostTools = [...PROBE_TOOLS, MISSING_TOOL];
  const scenario = await startScenario({
    hostTools, taskPreparation: { agentIds: ["dashboard-fixture"], ...PREPARATION },
  });
  const { gateway } = scenario;
  try {
    await assertFixtureConfig(gateway, hostTools);
    await t.test("preparation precedes real host search, lookup, and read in one native turn", async () => {
      await scenario.run({
        name: "prepared-search", message: "Search the synthetic reference, look up the fixture record, and read fixture.txt.",
        expectedTools: PROBE_TOOLS, unavailable: [MISSING_TOOL],
        calls: [searchCall(), lookupCall(), { name: "read", args: { path: "fixture.txt" } }],
      });
    });
    await t.test("missing requested name is omitted and explained before a no-tool draft", async () => {
      await scenario.run({
        name: "missing-draft", mode: "draft",
        message: "If fixture_missing is unavailable, draft a plan without claiming it ran.",
        expectedTools: PROBE_TOOLS, unavailable: [MISSING_TOOL],
        answer: "fixture_missing is unavailable. Draft plan: obtain the missing capability before running the lookup. No lookup was performed.",
      });
    });
  } finally { await gateway.close(); }
});

test("Agent tool deny still overrides the exact DSH ceiling with the synthetic provider enabled", { timeout: TIMEOUT }, async () => {
  const scenario = await startScenario({
    hostTools: PROBE_TOOLS, agentId: "dashboard-search-denied", agentToolPolicy: { deny: ["web_search"] },
  });
  const { gateway } = scenario;
  try {
    await assertFixtureConfig(gateway, PROBE_TOOLS);
    const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
    assert.deepEqual(config.agents.entries[gateway.agentId].tools, { deny: ["web_search"] });
    await scenario.run({
      name: "denied-search", message: "Search if permitted; otherwise explain the restriction without inventing results.",
      expectedTools: ["read", LOOKUP_TOOL], unavailable: ["web_search"],
      answer: "web_search is unavailable under this Agent's tool policy. No search was performed.",
    });
    await scenario.run({
      name: "denied-agent-lookup", message: "Use the permitted fixture lookup instead of web search.",
      expectedTools: ["read", LOOKUP_TOOL], unavailable: ["web_search"], calls: [lookupCall()],
    });
    assert.deepEqual((await gateway.searchFixture.readRecords()).filter((entry) =>
      ["search-create", "search-execute"].includes(entry.kind)), []);
  } finally { await gateway.close(); }
});

test("A provider being enabled cannot surface web_search outside the DSH exact-name list", { timeout: TIMEOUT }, async () => {
  const hostTools = ["read", LOOKUP_TOOL];
  const scenario = await startScenario({ hostTools, agentId: "dashboard-search-narrow" });
  const { gateway } = scenario;
  try {
    await assertFixtureConfig(gateway, hostTools);
    await scenario.run({
      name: "outside-ceiling", message: "Search only if a search tool is available; otherwise provide an honest draft.",
      expectedTools: hostTools,
      answer: "No web_search tool is available in this session. Draft: enable it through the approved tool configuration before searching.",
    });
    await scenario.run({
      name: "narrow-lookup", message: "Use fixture_lookup without widening the tool list.",
      expectedTools: hostTools, calls: [lookupCall()],
    });
    assert.deepEqual((await gateway.searchFixture.readRecords()).filter((entry) =>
      ["search-create", "search-execute"].includes(entry.kind)), []);
  } finally { await gateway.close(); }
});
