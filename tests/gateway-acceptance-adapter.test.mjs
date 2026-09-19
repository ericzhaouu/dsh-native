import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createGatewayAcceptanceAdapter, nativeTurnEvidence } from "../scripts/lib/gateway-acceptance-adapter.mjs";

const root = resolve("artifacts", "gateway-acceptance-adapter-test");
const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const item = (extra = {}) => ({ id: "unit-case", agentProfile: "scout", prompt: "Read the selected fixture",
  category: "business", limits: { timeoutMs: 2000 }, ...extra });

function nativeRows(name = "read") {
  return [
    { type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1 } },
    { type: "request/header", data: { header: { config: { provider: "github-copilot", model: "gpt-6-astra" } } } },
    { type: "tool/call", data: { turn: 1, callId: "call-1", name, arguments: '{"path":"/fixture.txt"}' } },
    { type: "tool/result", data: { turn: 1, message: { content: [
      { type: "tool-result", toolCallId: "call-1", content: "ok", isError: false },
    ] } } },
    { type: "turn/end", data: { turn: 1 } },
  ];
}

async function fixture(t, { finalText = "ok", tool = "read", dropFinal = false } = {}) {
  const runDir = join(root, randomUUID());
  const nativeStateDir = join(runDir, "native");
  const sessionId = randomUUID();
  const config = { hostRoot: resolve("node_modules", "openclaw"), configPath: join(runDir, "config.json"),
    stateDir: join(runDir, "state"), nativeStateDir, gatewayUrl: "ws://127.0.0.1:18789",
    agentMap: { scout: "agent-a" }, allowedAgentIds: ["agent-a"], ownedSessionPrefix: "acceptance-unit" };
  const directory = join(nativeStateDir, hash(sessionId));
  await mkdir(directory, { recursive: true });
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const events = [];
  const calls = [];
  const raw = [];
  let assistant;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "sessions.create") return { ok: true, key: params.key, entry: { sessionId, permissionMode: "read-only" } };
      if (method === "chat.send") {
        assistant = { role: "assistant", content: [{ type: "text", text: "ok" }],
          idempotencyKey: `dsh-native:${params.idempotencyKey}:assistant`, usage };
        raw.push({ id: randomUUID(), parentId: raw.at(-1)?.id ?? null, type: "message", message: assistant });
        await writeFile(join(directory, "binding.json"), JSON.stringify({
          status: "ready", lastRunId: params.idempotencyKey, sessionId: "native-session",
          taskPreparation: { state: { mode: "execute" } },
        }));
        if (!dropFinal) events.push({ event: "chat", payload: { sessionKey: params.sessionKey,
          runId: params.idempotencyKey, state: "final", message: { ...assistant, content: finalText } } });
        return { status: "started", runId: params.idempotencyKey };
      }
      if (method === "chat.history") return { sessionId, messages: [assistant], inFlightRun: false };
      if (method === "chat.abort") return { ok: true };
      throw new Error(`Unexpected method ${method}`);
    },
    async stopAndWait() {},
  };
  const adapter = await createGatewayAcceptanceAdapter({
    config, events, readNativeRows: async () => nativeRows(tool),
    connectionFactory: async () => ({ client, assertHealthy() {},
      hostConfig: { plugins: { entries: { "dsh-native": { config: { taskPreparation: { skillAllowlist: [] } } } } } },
      readTranscript: async () => raw }),
  });
  const reported = [];
  const context = { runId: randomUUID(), runDir, signal: new AbortController().signal,
    reportUsage: (value) => reported.push(value),
    resources: { modelVisibleContext: "Address: selected file", observations: { hiddenMetadata: "not a prompt" } } };
  return { adapter, context, calls, reported, config };
}

test("task-only inputs use actual event, canonical and native evidence without double-counting usage", async (t) => {
  const f = await fixture(t);
  const task = item();
  Object.defineProperty(task, "expected", { get() { throw new Error("DUT cannot see oracle"); } });
  const result = await f.adapter.executeCase(task, f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.businessResult, "partial");
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(result.usage.inputTokens, 3);
  assert.equal(result.usage.toolCalls, 1);
  assert.deepEqual(f.reported, [result.usage]);
  const sent = f.calls.find((call) => call.method === "chat.send").params;
  assert.equal(sent.metadata, undefined);
  assert.equal(sent.expectedPermissionMode, "read-only");
  assert.equal(f.calls[0].method, "sessions.create");
  assert.match(sent.message, /Address: selected file/);
  assert.doesNotMatch(sent.message, /hiddenMetadata|not a prompt/);
  assert.equal((await f.adapter.cleanupCase(task, f.context)).cleaned, true);
  assert.match(await readFile(join(f.context.runDir, "gateway-acceptance-ledger.jsonl"), "utf8"), /send_planned/);
});

test("compiled multi-turn strings remain distinct, rather than repeating the first prompt", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(item({ turns: ["First request", "Second request"] }), f.context);
  assert.deepEqual(result.turns.map((turn) => turn.prompt), ["First request", "Second request"]);
  assert.equal(result.usage.userTurns, 2);
});

test("foreign agents and actual channel requirements block without a send or business success", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.adapter.executeCase(item({ agentProfile: "foreign" }), f.context)).executionStatus, "infrastructure_blocked");
  assert.equal((await f.adapter.executeCase(item({ category: "delivery" }), f.context)).executionStatus, "infrastructure_blocked");
  assert.equal(f.calls.length, 0);
});

test("durable consumed-case marker prevents a repeated submission", async (t) => {
  const f = await fixture(t);
  await f.adapter.executeCase(item(), f.context);
  await assert.rejects(f.adapter.executeCase(item(), f.context), /EEXIST/);
  assert.equal(f.calls.filter((call) => call.method === "chat.send").length, 1);
});

test("history cannot substitute for a missing live final", async (t) => {
  const f = await fixture(t, { dropFinal: true });
  const task = item({ limits: { timeoutMs: 10 } });
  await assert.rejects(f.adapter.executeCase(task, f.context), /actual chat.final/);
  assert.equal((await f.adapter.cleanupCase(task, f.context)).cleaned, false);
  assert.ok(f.calls.some((call) => call.method === "chat.abort"));
});

test("live final/history disagreement remains failed and cannot produce a clean receipt", async (t) => {
  const f = await fixture(t, { finalText: "wrong" });
  await assert.rejects(f.adapter.executeCase(item(), f.context), /differs from committed/);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).cleaned, false);
});

test("unclassified exec effects stop further campaign work", async (t) => {
  const f = await fixture(t, { tool: "exec" });
  const result = await f.adapter.executeCase(item(), f.context);
  assert.equal(result.unknownEffects, true);
  assert.equal((await f.adapter.cleanupCase(item(), f.context)).cleaned, false);
});

test("incomplete native receipts and wrong model route cannot use zero-usage fallback", () => {
  const rows = nativeRows();
  assert.throws(() => nativeTurnEvidence(rows.filter((row) => row.type !== "tool/result"), { usage }), /terminal result/);
  const missingRoute = [rows[2], ...rows.filter((row) => row.type !== "request/header")];
  assert.throws(() => nativeTurnEvidence(missingRoute, { usage }), /github-copilot/);
  rows[2].data.header.config.model = "wrong-model";
  assert.throws(() => nativeTurnEvidence(rows, { usage }), /gpt-6-astra/);
});

test("Gateway config rejects non-loopback endpoints and embedded credentials", async (t) => {
  const f = await fixture(t);
  for (const url of ["wss://example.com", "ws://secret@127.0.0.1:18789"]) {
    await assert.rejects(createGatewayAcceptanceAdapter({ config: { ...f.config, gatewayUrl: url } }), /loopback/);
  }
});
