#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDshConfig } from "../dist/config.js";
import { createDshRuntime } from "../dist/runtime.js";
import { startModelServer } from "../tests/fixtures/model-server.mjs";

const DEFAULT_TURNS = 200;
const MAX_TURNS = 200;
const RESET_CADENCE_PER_AGENT = 10;
const AGENTS = ["synthetic-agent-a", "synthetic-agent-b"];
const SENTINEL_KEY = "offline-native-soak-loopback-key";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultArtifactsDir = join(repoRoot, "artifacts", "externalprivate");

function usage() {
  return "Usage: node scripts\\run-native-soak.mjs [--execute] [--turns <1-200>] [--keep-artifacts] [--artifacts-dir <repo\\artifacts\\externalprivate\\...>]";
}

function parseBoundedTurns(value) {
  if (!/^\d+$/.test(String(value))) throw new TypeError("--turns must be an integer between 1 and 200");
  const turns = Number(value);
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > MAX_TURNS) {
    throw new TypeError("--turns must be an integer between 1 and 200");
  }
  return turns;
}

function assertPrivateArtifactsDir(value) {
  const resolved = resolve(value ?? defaultArtifactsDir);
  const base = resolve(defaultArtifactsDir);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new TypeError("--artifacts-dir must be inside artifacts\\externalprivate");
  }
  return resolved;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    execute: false,
    dryRun: true,
    turns: DEFAULT_TURNS,
    keepArtifacts: false,
    artifactsDir: defaultArtifactsDir,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--execute") {
      args.execute = true;
      args.dryRun = false;
    } else if (arg === "--dry-run") {
      args.execute = false;
      args.dryRun = true;
    } else if (arg === "--turns") {
      if (argv[index + 1] === undefined) throw new TypeError(`--turns requires a value\n${usage()}`);
      args.turns = parseBoundedTurns(argv[++index]);
    } else if (arg === "--keep-artifacts") {
      args.keepArtifacts = true;
    } else if (arg === "--artifacts-dir") {
      if (argv[index + 1] === undefined) throw new TypeError(`--artifacts-dir requires a value\n${usage()}`);
      args.artifactsDir = assertPrivateArtifactsDir(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new TypeError(`Unknown argument ${arg}\n${usage()}`);
    }
  }
  args.artifactsDir = assertPrivateArtifactsDir(args.artifactsDir);
  return args;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") return textOf(value.text ?? value.content ?? value.output ?? "");
  return "";
}

function messageText(message) {
  return textOf(message?.content ?? message?.output ?? "");
}

function allBodyText(body) {
  return (body.messages ?? []).map(messageText).join("\n");
}

function markerFor(agent, agentTurn, totalTurn) {
  const epoch = Math.floor(agentTurn / RESET_CADENCE_PER_AGENT);
  return {
    agent,
    agentTurn,
    totalTurn,
    epoch,
    marker: `SOAK_MARKER agent=${agent} epoch=${epoch} agentTurn=${agentTurn} totalTurn=${totalTurn}`,
  };
}

function markerRegex() {
  return /SOAK_MARKER agent=(synthetic-agent-[ab]) epoch=(\d+) agentTurn=(\d+) totalTurn=(\d+)/g;
}

function markersIn(text) {
  return [...text.matchAll(markerRegex())].map((match) => ({
    marker: match[0],
    agent: match[1],
    epoch: Number(match[2]),
    agentTurn: Number(match[3]),
    totalTurn: Number(match[4]),
  }));
}

function lastUserMarker(body) {
  let found;
  for (let index = 0; index < (body.messages ?? []).length; index++) {
    const message = body.messages[index];
    if (message?.role !== "user") continue;
    const markers = markersIn(messageText(message));
    if (markers.length > 0) found = { ...markers.at(-1), index };
  }
  assert.ok(found, "model request must include a current synthetic user marker");
  return found;
}

function hasToolOutputAfter(body, userIndex, marker) {
  return (body.messages ?? []).slice(userIndex + 1).some((message) =>
    message?.role === "tool" && messageText(message).includes(`tool-output:${marker}`));
}

function shaJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingKey(nativeStateId) {
  return createHash("sha256").update(nativeStateId).digest("hex");
}

async function collectRuntimeState(root, runIds = new Set()) {
  const bindings = [];
  const locks = [];
  async function scan(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name === "binding.json") bindings.push({ path, value: JSON.parse(await readFile(path, "utf8")) });
      else if (entry.name === "owner.lock") {
        const text = await readFile(path, "utf8");
        const lock = JSON.parse(text);
        assert.equal(typeof lock.pid, "number", `Unexpected owner.lock pid shape at ${path}`);
        assert.equal(typeof lock.runId, "string", `Unexpected owner.lock runId shape at ${path}`);
        assert.equal(runIds.has(lock.runId), true, `Unexpected owner.lock runId at ${path}`);
        locks.push({ path, value: lock });
      }
    }
  }
  await scan(root);
  return { bindings, locks };
}

function makeInput({ root, model, turn, runId, nativeStateId, events, signal, executeTool }) {
  return {
    sessionId: `approved1.0plan:${turn.agent}`,
    nativeStateId,
    runId,
    workspaceDir: root,
    systemPrompt: "Offline native runtime state soak. Use only read_fixture. Do not write files.",
    prompt: `${turn.marker}\nCall read_fixture once, then answer with the returned probe.`,
    modelId: "deepseek-v4-pro",
    apiKey: SENTINEL_KEY,
    baseUrl: model.baseUrl,
    contextWindow: 1000000,
    maxTokens: 1000,
    thinking: "disabled",
    tools: [{
      name: "read_fixture",
      description: "Return a synthetic offline probe for the current soak marker.",
      parameters: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
        additionalProperties: false,
      },
    }],
    signal,
    assertActive() {},
    onEvent(event) { events.push({ runId, type: event.type, status: event.status }); },
    executeTool,
  };
}

async function runExecutedSoak(args) {
  const runLabel = `soak-${randomUUID()}`;
  const root = join(args.artifactsDir, runLabel);
  const metadata = {
    suite: "approved1.0plan-offline-native-runtime-state-soak",
    label: "offline native runtime state soak",
    loopbackOnly: true,
    turns: args.turns,
    maxTurns: MAX_TURNS,
    resetCadencePerAgent: RESET_CADENCE_PER_AGENT,
    turnTimeoutMs: 60000,
    agents: AGENTS,
  };
  const privateJsonSha256 = shaJson(metadata);
  await mkdir(root, { recursive: true });
  const model = await startModelServer(async ({ body, send, finish }) => {
    const current = lastUserMarker(body);
    const bodyText = allBodyText(body);
    for (const seen of markersIn(bodyText)) {
      assert.equal(seen.agent, current.agent, "other agent marker leaked into model request");
      assert.equal(seen.epoch, current.epoch, "pre-reset marker leaked into model request");
    }
    const turnRecord = turnRecords.get(current.marker);
    assert.ok(turnRecord, `unregistered turn marker ${current.marker}`);
    if (!hasToolOutputAfter(body, current.index, current.marker)) {
      assert.equal(turnRecord.callbacks, 0, "model attempted more than one tool phase");
      send({ role: "assistant", tool_calls: [{
        index: 0,
        id: `call-${createHash("sha256").update(current.marker).digest("hex").slice(0, 16)}`,
        type: "function",
        function: { name: "read_fixture", arguments: JSON.stringify({ marker: current.marker }) },
      }] });
      finish("tool_calls");
      return;
    }
    turnRecord.finals++;
    assert.equal(turnRecord.finals, 1, "model emitted more than one final response for a turn");
    send({ role: "assistant", content: `final:${current.marker}:tool-output:${current.marker}` });
    finish();
  });
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root,
    allowedBaseUrls: [model.baseUrl],
    startupTimeoutMs: 30000,
    shutdownTimeoutMs: 10000,
    streamIdleTimeoutMs: 3000,
  }));
  const runIds = new Set();
  const turnRecords = new Map();
  const nativeSessionByEpoch = new Map();
  const events = [];
  const latencies = [];
  let cleanup = { completed: false, scopedRoot: root, removedOwnedState: false };
  try {
    const perAgentTurns = Object.fromEntries(AGENTS.map((agent) => [agent, 0]));
    for (let totalTurn = 0; totalTurn < args.turns; totalTurn++) {
      const agent = AGENTS[totalTurn % AGENTS.length];
      const agentTurn = perAgentTurns[agent]++;
      const turn = markerFor(agent, agentTurn, totalTurn);
      const runId = `native-soak-${agent}-${totalTurn}-${randomUUID()}`;
      runIds.add(runId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`native soak turn ${totalTurn} timed out`)), 60000);
      const nativeStateId = `approved1.0plan:${agent}:native-soak-epoch-${turn.epoch}`;
      const record = { ...turn, callbacks: 0, finals: 0 };
      turnRecords.set(turn.marker, record);
      const started = Date.now();
      let result;
      try {
        result = await runtime.run(makeInput({
          root,
          model,
          turn,
          runId,
          nativeStateId,
          events,
          signal: controller.signal,
          executeTool: async (call) => {
            record.callbacks++;
            assert.equal(call.name, "read_fixture");
            assert.deepEqual(call.arguments, { marker: turn.marker });
            assert.equal(record.callbacks, 1, "host callback must dispatch once per attempt");
            return { text: `tool-output:${turn.marker}`, isError: false };
          },
        }));
      } finally {
        clearTimeout(timer);
      }
      latencies.push(Date.now() - started);
      assert.equal(result.stopReason, "stop");
      assert.equal(result.text, `final:${turn.marker}:tool-output:${turn.marker}`);
      assert.equal(result.toolCalls, 1);
      assert.equal(record.callbacks, 1);
      assert.equal(record.finals, 1);
      assert.ok(result.usage.input >= 0 && result.usage.output >= 0);
      const bindingPath = join(root, bindingKey(nativeStateId), "binding.json");
      const binding = JSON.parse(await readFile(bindingPath, "utf8"));
      const epochKey = `${agent}:${turn.epoch}`;
      if (nativeSessionByEpoch.has(epochKey)) {
        assert.equal(binding.sessionId, nativeSessionByEpoch.get(epochKey), "same epoch must resume the same native session");
      } else {
        nativeSessionByEpoch.set(epochKey, binding.sessionId);
      }
      assert.equal(binding.status, "ready");
      assert.equal(binding.lastRunId, runId);
    }
    await runtime.dispose();
    const state = await collectRuntimeState(root, runIds);
    assert.equal(state.locks.length, 0, "owner locks must be absent after settlement");
    for (const binding of state.bindings) assert.equal(binding.value.status, "ready", `binding not ready: ${binding.path}`);
    cleanup.completed = true;
    return {
      code: 0,
      summary: {
        label: metadata.label,
        execute: true,
        dryRunPassed: false,
        realTurnCount: args.turns,
        modelRequestCount: model.requests.length,
        toolCallbacks: [...turnRecords.values()].reduce((sum, turn) => sum + turn.callbacks, 0),
        finals: [...turnRecords.values()].reduce((sum, turn) => sum + turn.finals, 0),
        nativeBindingCount: state.bindings.length,
        ownerLockCountAfterSettlement: state.locks.length,
        previousNativeBindingsRetainedDuringRun: nativeSessionByEpoch.size === state.bindings.length,
        privateJsonSha256,
        resourceFacts: {
          driverRssBytes: process.memoryUsage().rss,
          childRssMeasured: false,
          statusEvents: events.filter((event) => event.type === "status").length,
          latencyMs: {
            min: Math.min(...latencies),
            max: Math.max(...latencies),
            avg: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
          },
        },
        cleanup,
      },
    };
  } finally {
    await runtime.dispose();
    await model.close();
    if (!args.keepArtifacts) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      cleanup.removedOwnedState = true;
    }
  }
}

function dryRunSummary(args) {
  return {
    code: 0,
    summary: {
      label: "offline native runtime state soak",
      execute: false,
      dryRunPassed: false,
      plannedOnly: true,
      realTurnCount: 0,
      plannedTurnCount: args.turns,
      maxTurns: MAX_TURNS,
      resetCadencePerAgent: RESET_CADENCE_PER_AGENT,
      agents: AGENTS,
      loopbackModelFixture: "tests\\fixtures\\model-server.mjs",
      wouldLaunchRuntimeOrModel: false,
    },
  };
}

export async function runNativeSoak(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, summary: { usage: usage() } };
  if (!args.execute) return dryRunSummary(args);
  return runExecutedSoak(args);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeSoak().then(({ code, summary }) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
