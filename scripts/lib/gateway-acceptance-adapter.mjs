import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveActiveResetBoundary } from "../../dist/native/reset-boundary.js";
import { validateUsageShape, zeroUsage } from "./acceptance-contract.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const textOf = (message) => typeof message?.content === "string" ? message.content :
  (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
const usageKeys = Object.keys(zeroUsage());
const sumUsage = (a, b) => Object.fromEntries([
  ...usageKeys.map((key) => [key, a[key] + b[key]]), ["priced", false],
]);

function validateConfig(value) {
  for (const key of ["hostRoot", "configPath", "stateDir", "nativeStateDir"]) {
    if (typeof value?.[key] !== "string" || !isAbsolute(value[key])) throw new Error(`${key} must be an absolute path`);
  }
  const url = new URL(value.gatewayUrl);
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("gatewayUrl must be an explicit credential-free loopback WebSocket endpoint");
  }
  if (!/^acceptance-[a-z0-9-]+$/.test(value.ownedSessionPrefix)) throw new Error("Invalid acceptance-owned session prefix");
  if (!Array.isArray(value.allowedAgentIds) || !value.allowedAgentIds.length ||
      !value.agentMap || typeof value.agentMap !== "object") throw new Error("Explicit agent mappings are required");
  for (const [logical, physical] of Object.entries(value.agentMap)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(logical) || !/^[a-z][a-z0-9_-]*$/.test(physical) ||
        !value.allowedAgentIds.includes(physical)) throw new Error("Mapped agent is not allowed");
  }
  if (value.isolation !== undefined && value.isolation !== "agent-policy-read-only") throw new Error("Unsupported evaluation isolation");
  return { ...value, gatewayUrl: url.href.replace(/\/$/, "") };
}

async function waitFor(predicate, signal, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function ledger(context, value) {
  await mkdir(context.runDir, { recursive: true, mode: 0o700 });
  await appendFile(join(context.runDir, "gateway-acceptance-ledger.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
}

async function readNativeRows(directory) {
  const files = [];
  async function visit(path, depth = 0) {
    if (depth > 8) throw new Error("Unexpected native transcript directory depth");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        if (entry.name === "session.jsonl") throw new Error("Native transcript cannot be a symlink");
        continue;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.name === "session.jsonl") files.push(child);
    }
  }
  await visit(join(directory, "home"));
  assert.equal(files.length, 1, "Expected one native transcript for the exact owned epoch");
  const text = await readFile(files[0], "utf8");
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Native evidence exceeds bounded case size");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function nativeTurnEvidence(rows, assistant) {
  const start = rows.findLastIndex((row) => row.type === "turn/start");
  if (start < 0) throw new Error("No native turn/start evidence");
  const current = rows.slice(start);
  const turn = current[0].data.turn;
  if (!current.some((row) => row.type === "turn/end" && row.data.turn === turn)) throw new Error("Native turn has not ended");
  const results = new Map();
  for (const row of current.filter((row) => row.type === "tool/result" && row.data.turn === turn)) {
    for (const block of row.data.message.content) {
      if (block.type === "tool-result") results.set(block.toolCallId, block);
    }
  }
  const calls = current.filter((row) => row.type === "tool/call" && row.data.turn === turn).map(({ data }) => {
    const result = results.get(data.callId);
    if (!result || typeof result.isError !== "boolean") throw new Error("Native tool call lacks its correlated terminal result");
    return { callId: data.callId, name: data.name,
      arguments: typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments,
      result: result.content, isError: result.isError };
  });
  const route = current.findLast((row) => row.type === "request/header" && row.data.header?.config)?.data.header.config;
  assert.equal(route?.provider, "github-copilot");
  assert.equal(route?.model, "gpt-6-astra");
  const raw = assistant.usage;
  const usage = {
    modelRequests: current.filter((row) => row.type === "step/start").length,
    inputTokens: raw?.input, outputTokens: raw?.output,
    cacheReadTokens: raw?.cacheRead, cacheWriteTokens: raw?.cacheWrite,
    toolCalls: calls.length, userTurns: 1, priced: false,
  };
  const errors = validateUsageShape(usage);
  if (errors.length || usage.modelRequests < 1) throw new Error(`Incomplete actual usage: ${errors.join("; ")}`);
  return { calls, usage, provider: route.provider, model: route.model };
}

function sideEffects(tools) {
  const effects = [];
  let unknown = false;
  for (const tool of tools) {
    if (["write", "edit", "apply_patch"].includes(tool.name)) effects.push({ kind: "write", tool: tool.name, callId: tool.callId });
    else if (!["read", "grep", "glob", "find", "ls", "web_search", "web_fetch"].includes(tool.name)) {
      effects.push({ kind: "unclassified", tool: tool.name, callId: tool.callId });
      unknown = true;
    }
  }
  return { effects, unknown };
}

async function realConnection(config, events) {
  const configBytes = await readFile(config.configPath, "utf8");
  const configFingerprint = hash(configBytes);
  const hostConfig = JSON.parse(configBytes);
  const [{ t: GatewayClient }, { t: version, s: buildId }, { n: loadDeviceIdentityIfPresent }, store] = await Promise.all([
    import(pathToFileURL(join(config.hostRoot, "dist/client-I-RoP1Al.js")).href),
    import(pathToFileURL(join(config.hostRoot, "dist/version-v1kuAkGj.js")).href),
    import(pathToFileURL(join(config.hostRoot, "dist/device-identity-J83pn_rP.js")).href),
    import(pathToFileURL(join(config.hostRoot, "dist/plugin-sdk/session-store-runtime.js")).href),
  ]);
  assert.equal(version, "2026.9.2", "The real adapter is pinned to the inspected SDK");
  const env = { ...process.env, OPENCLAW_STATE_DIR: config.stateDir, OPENCLAW_CONFIG_PATH: config.configPath };
  let resolveReady, rejectReady;
  let connectionError;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const client = new GatewayClient({
    url: config.gatewayUrl, origin: config.gatewayUrl.replace(/^ws/, "http"),
    token: hostConfig.gateway.auth.token, deviceIdentity: loadDeviceIdentityIfPresent(),
    deviceAuthScope: config.gatewayUrl, sharedStateMode: "read-only", env,
    clientName: "openclaw-control-ui", clientDisplayName: "DSH acceptance adapter",
    clientVersion: version, clientBuildId: buildId(), mode: "ui", scopes: ["operator.admin"],
    caps: ["task-suggestions"], instanceId: randomUUID(), minProtocol: 4, maxProtocol: 4,
    onHelloOk: resolveReady,
    onEvent: (frame) => {
      const key = frame.payload?.sessionKey;
      if (typeof key === "string" && config.allowedAgentIds.some((id) =>
        key.startsWith(`agent:${id}:${config.ownedSessionPrefix}-`))) events.push(frame);
    },
    onConnectError: (error) => { connectionError = error; rejectReady(error); },
    onGap: () => { connectionError = new Error("Gateway event stream lost frames"); },
    onClose: () => { connectionError = new Error("Gateway connection closed"); rejectReady(connectionError); },
  });
  client.start();
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Gateway connection deadline exceeded")), 30000);
    })]);
  } catch (error) {
    await client.stopAndWait({ timeoutMs: 10000 });
    throw error;
  } finally { clearTimeout(timer); }
  return {
    client, hostConfig,
    assertHealthy() {
      if (connectionError) throw connectionError;
      assert.equal(hash(readFileSync(config.configPath, "utf8")), configFingerprint,
        "Host evaluation policy changed during the campaign");
    },
    readTranscript: (scope) => store.loadTranscriptEventsSync({ ...scope, env }),
  };
}

export async function createGatewayAcceptanceAdapter(options = {}) {
  const inputPath = options.env?.DSH_ACCEPTANCE_GATEWAY_CONFIG ?? process.env.DSH_ACCEPTANCE_GATEWAY_CONFIG;
  if (!options.config && (!inputPath || !isAbsolute(inputPath))) throw new Error("Explicit private adapter config path is required");
  const config = validateConfig(options.config ?? JSON.parse(await readFile(inputPath, "utf8")));
  const events = options.events ?? [];
  let connection;
  const states = new Map();
  const gateway = async () => connection ??= await (options.connectionFactory
    ? options.connectionFactory(config, events) : realConnection(config, events));
  const request = async (method, params, signal, timeoutMs = 30000) => {
    signal?.throwIfAborted();
    const owner = await gateway();
    owner.assertHealthy();
    return owner.client.request(method, params, { timeoutMs });
  };
  const framesFor = (sessionKey, runId) => events.filter((frame) =>
    frame.payload?.sessionKey === sessionKey && frame.payload?.runId === runId);
  const assertFrames = (sessionKey, runId) => {
    const frames = framesFor(sessionKey, runId);
    const bad = frames.find((frame) => frame.event === "chat" && ["error", "aborted"].includes(frame.payload.state) ||
      frame.event === "agent" && frame.payload.stream === "lifecycle" &&
      ["error", "aborted", "fallback", "fallback_cleared"].includes(frame.payload.data?.phase));
    if (bad) throw new Error(`Owned Gateway turn failed (${bad.payload.state ?? bad.payload.data.phase}): ${
      bad.payload.errorMessage ?? bad.payload.data?.error ?? "See scoped terminal event"}`);
    return frames;
  };

  async function inspect(sessionKey, agentId, runId, signal) {
    const owner = await gateway();
    const history = await request("chat.history", { sessionKey, agentId, limit: 50 }, signal);
    if (!history.sessionId || history.inFlightRun) return undefined;
    const raw = await owner.readTranscript({ sessionKey, agentId, sessionId: history.sessionId });
    const boundary = resolveActiveResetBoundary(raw, history.sessionId);
    const stateId = boundary.kind === "clear" ? boundary.stateId : history.sessionId;
    const key = `${boundary.kind === "clear" ? boundary.assistantKeyPrefix : "dsh-native:"}${runId}:assistant`;
    const canonical = raw.findLast((row) => row.type === "message" && row.message?.idempotencyKey === key)?.message;
    const projected = history.messages?.find((message) =>
      (message.idempotencyKey ?? message.__openclaw?.idempotencyKey) === key);
    if (!canonical || !projected) return undefined;
    assert.equal(textOf(canonical), textOf(projected), "Canonical and projected assistant differ");
    const directory = join(config.nativeStateDir, hash(stateId));
    let binding;
    try { binding = JSON.parse(await readFile(join(directory, "binding.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    if (binding.status === "blocked") throw new Error("Native binding is blocked");
    if (binding.status !== "ready" || binding.lastRunId !== runId) return undefined;
    return { history, raw, boundary, canonical, binding, directory, key };
  }

  async function reset(state, context, afterTurn) {
    const before = await request("chat.history", { sessionKey: state.sessionKey, agentId: state.agentId, limit: 1 }, context.signal);
    const owner = await gateway();
    const raw = await owner.readTranscript({ sessionKey: state.sessionKey, agentId: state.agentId, sessionId: before.sessionId });
    const prior = resolveActiveResetBoundary(raw, before.sessionId);
    await ledger(context, { event: "reset_planned", sessionKey: state.sessionKey, afterTurn });
    const response = await request("sessions.reset", { key: state.sessionKey, agentId: state.agentId, reason: "new" }, context.signal, 120000);
    assert.equal(response.ok, true);
    assert.equal(response.key, state.sessionKey);
    const next = await owner.readTranscript({ sessionKey: state.sessionKey, agentId: state.agentId, sessionId: response.entry.sessionId });
    const boundary = resolveActiveResetBoundary(next, response.entry.sessionId);
    if (before.sessionId === response.entry.sessionId) {
      assert.deepEqual(next.slice(0, raw.length), raw, "Reset removed canonical history");
      assert.equal(boundary.kind, "clear");
      assert.notEqual(boundary.resetId, prior.resetId);
    }
    return { type: "new_context", appliesAfterTurn: afterTurn, receiptId: boundary.resetId ?? response.entry.sessionId,
      transportControlled: true, selfAsserted: false, sessionKey: state.sessionKey };
  }

  async function turn(testCase, context, state, prompt, index, duplicate) {
    const runId = randomUUID();
    const message = context.resources?.modelVisibleContext ? `${prompt}\n\n${context.resources.modelVisibleContext}` : prompt;
    const args = { sessionKey: state.sessionKey, agentId: state.agentId, message, thinking: "medium",
      timeoutMs: Math.min(testCase.limits.timeoutMs, 240000),
      ...(config.isolation ? {} : { expectedPermissionMode: "read-only" }), idempotencyKey: runId };
    await ledger(context, { event: "send_planned", caseId: testCase.id, runId, turn: index + 1,
      sessionKey: state.sessionKey, promptSha256: hash(message) });
    state.activeRunId = runId;
    const accepted = await request("chat.send", args, context.signal);
    assert.equal(accepted.runId, runId, "Host substituted the run identity");
    const final = await waitFor(() => {
      connection.assertHealthy();
      const finals = assertFrames(state.sessionKey, runId).filter((frame) => frame.event === "chat" && frame.payload.state === "final");
      assert.ok(finals.length <= 1, "Duplicate live terminal frame");
      return finals[0];
    }, context.signal, testCase.limits.timeoutMs, "actual chat.final frame");
    const settled = await waitFor(() => inspect(state.sessionKey, state.agentId, runId, context.signal),
      context.signal, 30000, "native/canonical settlement");
    assert.equal(textOf(final.payload.message), textOf(settled.canonical), "Live final differs from committed canonical text");
    const rows = await (options.readNativeRows ?? readNativeRows)(settled.directory);
    const native = nativeTurnEvidence(rows, settled.canonical);
    const business = native.calls.filter((call) => call.name !== "dsh_prepare_task");
    const policy = connection.hostConfig.plugins.entries["dsh-native"].config.taskPreparation;
    const advertised = policy?.skillAllowlistByAgent?.[state.agentId] ?? policy?.skillAllowlist ?? [];
    const loaded = advertised.filter((name) => business.some((call) =>
      call.name === "read" && !call.isError && typeof call.arguments?.path === "string" &&
      call.arguments.path.replace(/\\/g, "/").endsWith(`/${name}/SKILL.md`)));
    const mode = settled.binding.taskPreparation?.state.mode;
    if (!["chat", "clarify", "draft", "execute"].includes(mode)) throw new Error("Missing actual native preparation mode");
    context.reportUsage(native.usage);
    if (duplicate) {
      await ledger(context, { event: "duplicate_request_planned", runId, sessionKey: state.sessionKey });
      const beforeHash = hash(JSON.stringify(rows));
      const reply = await request("chat.send", args, context.signal);
      assert.equal(reply.runId, runId);
      await new Promise((done) => setTimeout(done, 1000));
      const after = await inspect(state.sessionKey, state.agentId, runId, context.signal);
      assert.ok(after, "Duplicate request restarted or replaced the turn");
      assert.equal(hash(JSON.stringify(await (options.readNativeRows ?? readNativeRows)(after.directory))), beforeHash,
        "Duplicate request replayed native work");
    }
    assert.equal(assertFrames(state.sessionKey, runId).filter((frame) => frame.event === "chat" && frame.payload.state === "final").length, 1);
    state.activeRunId = undefined;
    await ledger(context, { event: "turn_settled", runId, sessionKey: state.sessionKey });
    return {
      agentProfile: testCase.agentProfile, prompt, outputText: textOf(settled.canonical), mode,
      executionStatus: mode === "clarify" ? "correctly_blocked" : "completed",
      tools: business, skill: { advertised, selected: loaded, loaded }, usage: native.usage,
      delivery: { delivered: true, terminalOutputs: 1, receiptId: runId, recipient: state.sessionKey },
      provider: native.provider, model: native.model, sessionId: settled.history.sessionId,
      nativeSessionId: settled.binding.sessionId, runId,
    };
  }

  return {
    async executeCase(testCase, context) {
      const agentId = config.agentMap[testCase.agentProfile];
      const block = (reason) => {
        states.set(testCase.id, { settled: true });
        return { executionStatus: "infrastructure_blocked", businessResult: "failed", outputText: "",
          policyFacts: { blockedReason: reason }, sideEffects: [], usage: { ...zeroUsage(), priced: false },
          delivery: { delivered: false, terminalOutputs: 0 }, turns: [] };
      };
      if (!agentId || !config.allowedAgentIds.includes(agentId)) return block("Agent profile not authorized");
      if (testCase.category === "delivery") return block("Actual Feishu controls require the channel adapter, not Gateway proxying");
      if ((testCase.adapterControls ?? []).some((item) => !["new_context", "duplicate_inbound_delivery"].includes(item.type))) {
        return block("Unsupported Gateway control; no input sent");
      }
      const token = hash(`${context.runId}:${testCase.id}`).slice(0, 24);
      await mkdir(context.runDir, { recursive: true, mode: 0o700 });
      await writeFile(join(context.runDir, `gateway-case-${token}.json`),
        JSON.stringify({ caseId: testCase.id, runId: context.runId }), { flag: "wx", mode: 0o600 });
      const state = { sessionKey: `agent:${agentId}:${config.ownedSessionPrefix}-${token}`, agentId, settled: false };
      states.set(testCase.id, state);
      const startedAt = Date.now();
      const turns = [];
      const controlReceipts = [];
      let usage = { ...zeroUsage(), priced: false };
      try {
        if (config.isolation === "agent-policy-read-only") {
          const owner = await gateway();
          const agent = owner.hostConfig.agents.entries[agentId];
          assert.ok(agentId.startsWith("dsh-acceptance-"), "Agent-policy isolation requires a dedicated test Agent");
          assert.ok(Array.isArray(agent?.tools?.allow) && agent.tools.allow.length > 0 &&
            agent.tools.allow.every((name) => ["read", "grep", "glob", "find", "ls"].includes(name)),
          "Dedicated test Agent must have an explicit read-only tool allowlist");
          assert.equal(agent.tools.fs?.workspaceOnly ?? owner.hostConfig.tools?.fs?.workspaceOnly, true,
            "Dedicated Agent filesystem tools must be workspace-only");
          await ledger(context, { event: "read_only_agent_policy_verified", sessionKey: state.sessionKey, agentId });
        } else {
          await ledger(context, { event: "read_only_session_planned", sessionKey: state.sessionKey, agentId });
          const created = await request("sessions.create", {
            key: state.sessionKey, agentId, permissionMode: "read-only", idempotencyKey: `create-${token}`,
          }, context.signal);
          assert.equal(created.ok, true);
          assert.equal(created.key, state.sessionKey);
          assert.equal(created.entry?.permissionMode, "read-only", "Host must confirm read-only scope before any model input");
        }
        const prompts = testCase.turns ?? [testCase.prompt];
        for (const [index, prompt] of prompts.entries()) {
          assert.equal(typeof prompt, "string", "Compiled turns must be original prompt strings");
          if (index && testCase.adapterControls?.some((item) => item.type === "new_context" && item.appliesAfterTurn === index)) {
            controlReceipts.push(await reset(state, context, index));
          }
          const duplicate = testCase.adapterControls?.some((item) => item.type === "duplicate_inbound_delivery" && item.appliesToTurn === index + 1);
          const result = await turn(testCase, context, state, prompt, index, duplicate);
          turns.push(result);
          usage = sumUsage(usage, result.usage);
          if (duplicate) controlReceipts.push({ type: "duplicate_inbound_delivery", appliesToTurn: index + 1,
            receiptId: result.runId, transportControlled: true, selfAsserted: false, surface: "Gateway-RPC" });
        }
        const effects = sideEffects(turns.flatMap((item) => item.tools));
        state.settled = !effects.unknown && effects.effects.length === 0;
        return {
          executionStatus: turns.at(-1).executionStatus, businessResult: "partial", outputText: turns.at(-1).outputText,
          turns, usage, sideEffects: effects.effects, unknownEffects: effects.unknown || undefined, controlReceipts,
          delivery: { delivered: true, terminalOutputs: turns.length, recipient: state.sessionKey },
          policyFacts: { mode: turns.at(-1).mode, adapter: "real-Gateway-not-Feishu" }, latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        await ledger(context, { event: "case_failed", caseId: testCase.id, reason: error.message,
          activeRunId: state.activeRunId, sessionKey: state.sessionKey });
        throw error;
      }
    },
    async cleanupCase(testCase, context) {
      const state = states.get(testCase.id);
      if (!state) return { cleaned: false, error: "No execution/skip receipt for this case" };
      if (state.activeRunId) {
        try {
          await request("chat.abort", { sessionKey: state.sessionKey, runId: state.activeRunId }, undefined, 10000);
          await ledger(context, { event: "abort_requested", sessionKey: state.sessionKey, runId: state.activeRunId });
        } catch (error) {
          return { cleaned: false, error: `Owned abort unconfirmed: ${error.message}` };
        }
        return { cleaned: false, receipt: "Abort requested; uncertain turn prevents further work" };
      }
      return state.settled ? { cleaned: true, receipt: "Owned native turn settled; read-only evidence retained" }
        : { cleaned: false, error: "Uncertain effects or failed execution require review" };
    },
    async close() {
      if (connection) await connection.client.stopAndWait({ timeoutMs: 10000 });
    },
  };
}

export function createAdapter() {
  return createGatewayAcceptanceAdapter();
}
